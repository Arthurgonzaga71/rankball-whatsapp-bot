import test from 'node:test'
import assert from 'node:assert/strict'
import { sendGroupMessage } from './manual-group-send.mjs'

function clientFor(group) {
  const filters = {}
  return { from: () => ({ select() { return this }, eq(key, value) { filters[key] = value; return this }, async maybeSingle() { return { data: group?.id === filters.id && group?.active === filters.active ? group : null, error: null } } }) }
}
const group = { id: 'group-1', name: 'Grupo', organization_id: 'org', group_jid: '123@g.us', active: true }
test('envia ao grupo ativo selecionado e usa os dados da organização correta', async () => {
  const sent = []
  const socket = { groupMetadata: async jid => assert.equal(jid, group.group_jid), sendMessage: async (jid, message) => { sent.push({ jid, message }); return { key: { id: 'message-id' } } } }
  const result = await sendGroupMessage({ client: clientFor(group), socket, groupId: group.id, createMessage: async selected => `org:${selected.organization_id}` })
  assert.equal(result.ok, true)
  assert.deepEqual(sent, [{ jid: group.group_jid, message: { text: 'org:org' } }])
})
test('não envia para grupo inativo ou diferente do selecionado', async () => {
  const socket = { groupMetadata: async () => assert.fail(), sendMessage: async () => assert.fail() }
  const result = await sendGroupMessage({ client: clientFor({ ...group, active: false }), socket, groupId: group.id, createMessage: async () => '' })
  assert.equal(result.status, 404)
})
test('não confirma sucesso quando o WhatsApp rejeita o envio', async () => {
  const socket = { groupMetadata: async () => ({}), sendMessage: async () => { throw new Error('envio falhou') } }
  await assert.rejects(sendGroupMessage({ client: clientFor(group), socket, groupId: group.id, createMessage: async () => 'teste' }), /envio falhou/)
})
