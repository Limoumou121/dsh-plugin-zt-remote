import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Minimal DOM-free React stub for the client bundle.
 *
 * The bundle is a `__ModuleLoader__.load` factory that requires React at runtime;
 * this harness supplies just enough of the React surface for the panel component
 * (`createElement`, `useState`, `useEffect`, `useRef`, `useCallback`) and an
 * element tree walker, so the bundle's component logic can be exercised under
 * plain Node instead of a browser. No test here claims a rendered page.
 */

/** Marker for the harness's element nodes. */
const ELEMENT = Symbol('element')

/**
 * Build the fake React module pair plus the tree walker.
 * @returns the React module, the JSX runtime, and the tree helpers.
 */
function createReactStub() {
  let hookContext = null

  /** Rendered component instances, keyed by the caller's `stateKey`. */
  const states = new Map()

  /** The hook context in effect, failing loudly when a component renders outside one. */
  function current() {
    if (hookContext === null) throw new Error('a component rendered outside the test renderer')
    return hookContext
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      /* The automatic runtime carries children inside props; explicit createElement
         arguments win, and an empty argument list keeps a `children` prop already
         present. Overwriting it with `undefined` would drop the whole tree. */
      const produced = children.length === 0 ? props?.children : children.length === 1 ? children[0] : children
      return { [ELEMENT]: true, type, props: { ...(props ?? {}), children: produced } }
    },
    useState(initial) {
      const context = current()
      const index = context.hookCalls
      context.hookCalls += 1
      if (context.hooks[index] === undefined) context.hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(context.hooks[index]) : next
        if (!Object.is(context.hooks[index], value)) {
          context.hooks[index] = value
          context.dirty = true
        }
      }
      return [context.hooks[index], set]
    },
    useEffect(effect, deps) {
      const context = current()
      /* The hook's position is its call index within this render, so a later render of
         the same instance reads the deps this hook stored last time. */
      const index = context.effectCalls
      context.effectCalls += 1
      if (!context.runEffects) return
      const previous = context.effects[index]
      const changed =
        previous === undefined ||
        deps === undefined ||
        deps.length !== previous.length ||
        deps.some((value, at) => !Object.is(value, previous[at]))
      if (!changed) return
      context.effects[index] = deps
      const cleanup = effect()
      if (typeof cleanup === 'function') context.cleanups.push(cleanup)
    },
    useRef(initial) {
      const context = current()
      const index = context.hookCalls
      context.hookCalls += 1
      if (context.hooks[index] === undefined) context.hooks[index] = { current: initial }
      return context.hooks[index]
    },
    useCallback(callback, deps) {
      const context = current()
      const index = context.callbackCalls
      context.callbackCalls += 1
      const previous = context.callbacks[index]
      if (
        previous !== undefined &&
        deps !== undefined &&
        deps.length === previous.deps.length &&
        deps.every((value, at) => Object.is(value, previous.deps[at]))
      ) {
        return previous.callback
      }
      context.callbacks[index] = { deps: deps ?? [], callback }
      return callback
    },
    memo: (component) => component,
    forwardRef: (component) => component,
    StrictMode: Symbol('StrictMode'),
  }

  const jsx = {
    /* The automatic runtime passes children inside props; the third `key` argument is
       forwarded as a prop the way the real runtime splits it out. */
    jsx: (type, props, key) => React.createElement(type, props === undefined ? undefined : { ...props, key }),
    jsxs: (type, props, key) => React.createElement(type, props === undefined ? undefined : { ...props, key }),
    Fragment: React.Fragment,
  }

  /**
   * Render one element tree with the stub hooks.
   *
   * State is keyed by the rendered component, so two `render` calls with one
   * component continue the same instance the way React does: setters published by an
   * async effect are visible on the next call, and an effect whose deps did not change
   * does not run twice.
   *
   * @param element - element or component to render.
   * @param available - `runEffects` starts the effects during this pass; `stateKey`
   *   names the instance whose hooks persist.
   * @returns `{ tree, dirty, cleanups }`.
   */
  function render(element, available) {
    const key = available.stateKey ?? 'default'
    const state = states.get(key) ?? { hooks: [], effects: [], callbacks: [], cleanups: [], dirty: false }
    states.set(key, state)
    const context = { ...state, runEffects: available.runEffects === true, hookCalls: 0, effectCalls: 0, callbackCalls: 0 }
    const previous = hookContext
    hookContext = context
    let tree
    try {
      tree = expand(element, context)
    } finally {
      hookContext = previous
    }
    /* Copy the mutated hook slots back so the next render continues this instance. */
    state.hooks = context.hooks
    state.effects = context.effects
    state.callbacks = context.callbacks
    state.cleanups = context.cleanups
    state.dirty = context.dirty
    return { tree, dirty: context.dirty, cleanups: context.cleanups }
  }

  /** Unmount one rendered instance, running the cleanups React would run. */
  function unmount(key = 'default') {
    const state = states.get(key)
    if (state === undefined) return
    for (const cleanup of state.cleanups) cleanup()
    states.delete(key)
  }

  /**
   * Expand one node into the tree plain objects the assertions walk.
   * @param node - element, array, string, or number.
   * @param context - hook context for nested components.
   * @returns the expanded node.
   */
  function expand(node, context) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child) => expand(child, context))
    if (node[ELEMENT] !== true) return node
    const { type, props } = node
    const previous = hookContext
    hookContext = context
    try {
      if (typeof type === 'function') return expand(type(props ?? {}), context)
      if (typeof type === 'symbol') return expand(props?.children ?? null, context)
    } finally {
      hookContext = previous
    }
    return { tag: String(type), props: props ?? {}, children: expand(props?.children ?? null, context) }
  }

  /** Depth-first walk over host nodes carrying a tag. */
  function* walk(tree) {
    if (tree === null || tree === undefined) return
    if (Array.isArray(tree)) {
      for (const child of tree) yield* walk(child)
      return
    }
    if (typeof tree !== 'object' || tree.tag === undefined) return
    yield tree
    yield* walk(tree.children)
  }

  /** Read the text one subtree renders, ignoring null slots. */
  function textOf(tree) {
    if (tree === null || tree === undefined || tree === false) return ''
    if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
    if (Array.isArray(tree)) return tree.map(textOf).join('')
    if (typeof tree === 'object' && tree.tag !== undefined) return textOf(tree.children)
    return ''
  }

  return { React, jsx, render, unmount, walk, textOf }
}
/**
 * Load the client bundle against the stub React and a recording fetch.
 * @param fetchImpl - `(input, init) => Response` used for every panel request.
 * @param restores - optional array the returned restorer is pushed onto, so a caller
 *   can undo the global stubs after its test.
 * @returns captured registrations, the loaded exports, and the harness helpers.
 */
export function loadClientBundle(fetchImpl, restores) {
  const { React, jsx, render, unmount, walk, textOf } = createReactStub()
  const code = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

  const registrations = []
  let factory = null
  const slots = {
    inject(key, callback) {
      /* The host runs the callback for the owner declaration's lifetime; the harness
         runs it once, which is what a mounted owner does. */
      registrations.push({ kind: 'inject', key, callback })
      callback()
    },
    register(options, component) {
      registrations.push({ kind: 'register', options, component })
      return () => {}
    },
  }
  const ctx = { slots, effect: () => () => {} }
  const moduleLoader = {
    load: ({ id, factory: produced }) => {
      registrations.push({ kind: 'load', id })
      factory = produced
    },
  }
  const window = { __ModuleLoader__: moduleLoader }
  const calls = []
  const fetchStub = (input, init) => {
    calls.push({ input: String(input), init: init ?? {} })
    return fetchImpl(String(input), init ?? {})
  }
  const require = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsx
    throw new Error(`the client bundle required an unexpected module: ${name}`)
  }

  /* `window` and `fetch` are the two globals the browser bundle reads. Both stubs must
     stay installed while the panel's effects run, so the caller restores them through
     the returned `restore` at the end of its test. */
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = window
  globalThis.fetch = fetchStub
  const restore = () => {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
  restores?.push(restore)
  let loaded
  try {
    new Function('require', code)(require)
    if (typeof factory !== 'function') throw new Error('the bundle did not open a module factory')
    loaded = factory(require)
    loaded.apply(ctx)
  } catch (error) {
    restore()
    throw error
  }

  const registered = registrations.filter((entry) => entry.kind === 'register')
  const componentFor = (name, keyOrId) =>
    registered.find((entry) => entry.options.name === name && (entry.options.id ?? entry.options.key) === keyOrId)

  return {
    exports: loaded,
    registrations,
    registered,
    componentFor,
    calls,
    render,
    unmount,
    walk,
    textOf,
    fetchStub,
    createElement: React.createElement,
    ctx,
    restore,
  }
}
