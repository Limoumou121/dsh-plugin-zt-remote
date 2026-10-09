import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBindAddress, listIpv4Interfaces } from '../net.js'

/** Two named interfaces plus an unrelated one, as a host with ZeroTier installed reports. */
const interfaces = [
  { name: 'Ethernet', address: '192.168.1.20' },
  { name: 'ZeroTier One [a1b2c3d4]', address: '10.8.0.2' },
  { name: 'vEthernet (WSL)', address: '172.20.0.1' },
]

test('auto-detection selects the ZeroTier interface by name', () => {
  assert.deepEqual(resolveBindAddress('', 'zerotier', interfaces), { name: 'ZeroTier One [a1b2c3d4]', address: '10.8.0.2' })
})

test('an explicit address wins and reports the matching interface name', () => {
  assert.deepEqual(resolveBindAddress('172.20.0.1', 'zerotier', interfaces), { name: 'vEthernet (WSL)', address: '172.20.0.1' })
  assert.deepEqual(resolveBindAddress('10.9.9.9', 'zerotier', interfaces), { name: 'configured', address: '10.9.9.9' })
})

test('no match fails loud instead of widening to every interface', () => {
  assert.throws(() => resolveBindAddress('', 'zerotier', [{ name: 'Ethernet', address: '192.168.1.20' }]), /no interface name matches/)
})

test('several matches require an explicit address', () => {
  const two = [
    { name: 'ZeroTier One [a]', address: '10.8.0.2' },
    { name: 'ZeroTier One [b]', address: '10.9.0.2' },
  ]
  assert.throws(() => resolveBindAddress('', 'zerotier', two), /2 interfaces match/)
})

test('the live host list never contains loopback addresses', () => {
  for (const iface of listIpv4Interfaces()) assert.equal(iface.address.startsWith('127.'), false)
})
