import test from 'node:test'
import assert from 'node:assert/strict'
import { formatPresenceList } from './presence-list.mjs'
import { guestNameFromCommand } from './commands.mjs'

test('formata a lista com data da partida, comandos e situações', () => {
  const match = { starts_at: '2026-11-30T23:00:00Z', ends_at: '2026-12-01T01:00:00Z' }
  const players = [
    { id: '1', first_name: 'Arthur', last_name: 'Gonzaga', primary_position: 'ATACANTE' },
    { id: '2', first_name: 'Carlos', last_name: '', primary_position: 'GOLEIRO' },
  ]
  const text = formatPresenceList(match, players, [{ player_id: '1', status: 'CONFIRMED' }, { player_id: '2', status: 'INJURED' }], [{ name: 'João', confirmed: true }])
  assert.match(text, /Segunda-feira \(30\/11\/2026\), das 20h às 22h/)
  assert.match(text, /!vou ou !euvou/)
  assert.match(text, /1\. Arthur Gonzaga ✅/)
  assert.match(text, /1\. 🧤 Carlos 🚑/)
  assert.match(text, /1\. João ✅/)
})

test('aceita nome do convidado entre aspas', () => {
  assert.equal(guestNameFromCommand('!convidado “João Silva”'), 'João Silva')
})
