export async function sendGroupMessage({ client, socket, groupId, createMessage }) {
  const { data: group, error } = await client.from('whatsapp_groups').select('id,name,organization_id,group_jid').eq('id', groupId).eq('active', true).maybeSingle()
  if (error) throw error
  if (!group) return { ok: false, status: 404, message: 'Grupo ativo não encontrado. Atualize a página e selecione novamente.' }
  if (!group.group_jid?.endsWith('@g.us')) return { ok: false, status: 400, message: 'O endereço do grupo cadastrado é inválido.' }
  try { await socket.groupMetadata(group.group_jid) } catch (error) {
    console.error('Não foi possível acessar o grupo selecionado:', error)
    return { ok: false, status: 409, message: 'O bot não conseguiu acessar o grupo. Confira se o número conectado participa dele.' }
  }
  const text = await createMessage(group)
  const result = await socket.sendMessage(group.group_jid, { text })
  if (!result?.key?.id) throw new Error('O WhatsApp não retornou um identificador para a mensagem.')
  console.log(`Ação do painel: mensagem enviada ao WhatsApp para o grupo ${group.id}, id ${result.key.id}.`)
  return { ok: true, status: 200, message: `Mensagem enviada ao WhatsApp para o grupo ${group.name || 'selecionado'}.` }
}
