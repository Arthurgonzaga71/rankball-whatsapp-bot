import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { getAggregateVotesInPollMessage, updateMessageWithPollUpdate } from '@whiskeysockets/baileys'
import { serializePollMessage, restorePollMessage } from './award-poll-state.mjs'

test('preserva a enquete e os votos após salvar e recuperar o estado', () => {
  const message = restorePollMessage({ key: { id: 'poll', remoteJid: '123@g.us', fromMe: true }, message: { pollCreationMessage: { name: 'Melhor meia', options: [{ optionName: 'Ana' }, { optionName: 'Bia' }], selectableOptionsCount: 1 } } })
  const vote = name => ({ pollUpdateMessageKey: { remoteJid: '123@g.us', participant: '5511999999999@s.whatsapp.net', id: 'vote' }, vote: { selectedOptions: [createHash('sha256').update(name).digest()] } })
  updateMessageWithPollUpdate(message, vote('Ana'))
  const restored = restorePollMessage(JSON.parse(JSON.stringify(serializePollMessage(message))))
  assert.deepEqual(getAggregateVotesInPollMessage(restored).map(option => option.voters.length), [1, 0])
  updateMessageWithPollUpdate(restored, vote('Bia'))
  assert.deepEqual(getAggregateVotesInPollMessage(restored).map(option => option.voters.length), [0, 1])
  updateMessageWithPollUpdate(restored, { ...vote('Bia'), vote: { selectedOptions: [] } })
  assert.deepEqual(getAggregateVotesInPollMessage(restored).map(option => option.voters.length), [0, 0])
})
