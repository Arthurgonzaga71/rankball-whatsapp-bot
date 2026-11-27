import test from'node:test'
import assert from'node:assert/strict'
import{helpMessage,parseCommand,phoneCandidatesFromJid,samePhone}from'./commands.mjs'

test('aceita comandos com prefixo, acentos e maiúsculas',()=>{
  assert.equal(parseCommand('!Vou'),'VOU')
  assert.equal(parseCommand(' !NÃO VOU '),'NAOVOU')
  assert.equal(parseCommand('!lesionado'),'LESIONADO')
})
test('reconhece as formas de confirmar e informar ausência divulgadas na lista',()=>{
  for(const input of ['!euvou','!eu vou','!vou','PRESENTE'])assert.equal(parseCommand(input),'VOU')
  for(const input of ['!naovou','!não vou','não vou'])assert.equal(parseCommand(input),'NAOVOU')
  for(const input of ['!lesão','!doente'])assert.equal(parseCommand(input),'LESIONADO')
})
test('ignora mensagens que não são comandos suportados',()=>{
  assert.equal(parseCommand('boa noite, pessoal'),null)
  assert.equal(parseCommand('!pagamento'),null)
})
test('oferece ajuda em português',()=>assert.match(helpMessage(),/!vou/))
test('aceita o comando de menu',()=>assert.equal(parseCommand('!menu'),'MENU'))
test('gera formatos brasileiro e internacional a partir do JID',()=>{
  assert.deepEqual(phoneCandidatesFromJid('5571999999999@s.whatsapp.net'),['5571999999999','71999999999'])
})
test('reconhece telefones brasileiros mesmo formatados',()=>{
  assert.equal(samePhone('(73) 9 9999-9999','5573999999999'),true)
  assert.equal(samePhone('73 99999-9999','5573988888888'),false)
  assert.equal(samePhone('7199717211','5571999717211'),true)
})
