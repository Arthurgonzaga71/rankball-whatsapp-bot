import 'dotenv/config'
import http from'node:http'
import makeWASocket,{DisconnectReason,fetchLatestBaileysVersion,generateWAMessageFromContent,getAggregateVotesInPollMessage,makeCacheableSignalKeyStore,proto,updateMessageWithPollUpdate,useMultiFileAuthState,decryptPollVote,getKeyAuthor,jidNormalizedUser,normalizeMessageContent}from'@whiskeysockets/baileys'
import {Boom} from'@hapi/boom'
import P from'pino'
import QRCode from'qrcode'
import qrcode from'qrcode-terminal'
import {createClient}from'@supabase/supabase-js'
import{guestNameFromCommand,helpMessage,parseCommand,phoneCandidatesFromJid,samePhone}from'./commands.mjs'
import{formatPresenceList}from'./presence-list.mjs'
import{serializePollMessage,restorePollMessage}from'./award-poll-state.mjs'
import{useSupabaseAuthState}from'./supabase-auth.mjs'

const required=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','BOT_QR_TOKEN'];for(const key of required)if(!process.env[key])throw Error(`Defina ${key} no arquivo .env`)
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const originalChannel=supabase.channel.bind(supabase);let realtimeChannelSequence=0
// O Baileys pode reconectar o socket; cada ciclo precisa de um canal Realtime novo.
supabase.channel=(topic,options)=>originalChannel(`${topic}-${Date.now()}-${++realtimeChannelSequence}`,options)
const logger=P({level:process.env.LOG_LEVEL||'silent'});const authDir=process.env.BAILEYS_AUTH_DIR||'./auth_info'
const textOf=message=>{
  message=normalizeMessageContent(message)||message
  const selectedRow=message?.listResponseMessage?.singleSelectReply?.selectedRowId||message?.buttonsResponseMessage?.selectedButtonId
  if(selectedRow)return selectedRow
  const params=message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
  if(params){try{return JSON.parse(params).id||''}catch{return ''}}
  return message?.conversation||message?.extendedTextMessage?.text||message?.imageMessage?.caption||''
}
const normalize=text=>text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase()
const port=Number(process.env.PORT||3000)
const qrToken=process.env.BOT_QR_TOKEN
let whatsappConnected=false
let latestQr=''
let currentSocket=null
let realtimeChannel=null
let reconnectTimer=null
let automationTimer=null
let awardResultTimer=null
let listProcessing=false
let shuttingDown=false
const presencePolls=new Map()
const presencePollVotes=new Map()
const awardPolls=new Map()
const testAwardPolls=new Map()
const awardVoteQueues=new Map()
async function processEncryptedPollVote(sock,message){
  const update=normalizeMessageContent(message.message)?.pollUpdateMessage
  const creationKey=update?.pollCreationMessageKey
  if(!creationKey?.id||!update.vote)return false
  const poll=awardPolls.get(creationKey.id)||testAwardPolls.get(creationKey.id)||presencePolls.get(creationKey.id)
  if(!poll)return false
  const secret=poll.message?.message?.messageContextInfo?.messageSecret
  if(!secret)throw new Error('Chave da enquete não encontrada.')
  const me=jidNormalizedUser(sock.user?.id||'')
  const creatorCandidates=[getKeyAuthor(creationKey,me),me,sock.user?.lid].filter(Boolean)
  const voterCandidates=[getKeyAuthor(message.key,me),message.key.participant,message.key.participantAlt,message.key.remoteJidAlt,message.key.remoteJid].filter(Boolean)
  let decrypted,lastError
  for(const creator of new Set(creatorCandidates)){
    for(const voter of new Set(voterCandidates)){
      try{decrypted=decryptPollVote(update.vote,{pollCreatorJid:jidNormalizedUser(creator),pollMsgId:creationKey.id,pollEncKey:secret,voterJid:jidNormalizedUser(voter)});break}catch(error){lastError=error}
    }
    if(decrypted)break
  }
  if(!decrypted)throw lastError||new Error('Não foi possível descriptografar o voto.')
  sock.ev.emit('messages.update',[{key:creationKey,update:{pollUpdates:[{pollUpdateMessageKey:message.key,vote:decrypted,senderTimestampMs:update.senderTimestampMs}]}}])
  console.log('Voto de enquete recebido.')
  return true
}
http.createServer(async(request,response)=>{const url=new URL(request.url||'/',`http://localhost:${port}`);if(request.method==='POST'&&['/internal/send-list','/internal/send-menu'].includes(url.pathname)){if(request.headers.authorization!==`Bearer ${qrToken}`){response.writeHead(401);response.end('N?o autorizado');return}if(!currentSocket||!whatsappConnected){response.writeHead(409);response.end('WhatsApp desconectado.');return}try{const{data:groups,error}=await supabase.from('whatsapp_groups').select('organization_id,group_jid').eq('name','Terceiro Tempo FC').eq('active',true);if(error)throw error;if(!groups?.length){response.writeHead(404);response.end('Grupo Terceiro Tempo FC n?o encontrado.');return}for(const group of groups){const text=url.pathname==='/internal/send-list'?await presenceListV2(group.organization_id):helpMessage();await currentSocket.sendMessage(group.group_jid,{text})}response.writeHead(200);response.end('Mensagem enviada ao grupo Terceiro Tempo FC.')}catch(error){console.error('Falha na a??o solicitada pelo painel:',error);response.writeHead(500);response.end('N?o foi poss?vel enviar a mensagem. Consulte os logs do bot.')}return}if(url.pathname==='/health'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:true,whatsappConnected,service:'rankball-whatsapp-bot'}));return}if(url.pathname==='/qr'){if(url.searchParams.get('token')!==qrToken){response.writeHead(403);response.end('Acesso negado.');return}if(!latestQr){response.writeHead(404,{'content-type':'text/html; charset=utf-8'});response.end('<h1>QR ainda não disponível</h1><p>Atualize esta página após o bot gerar o QR.</p>');return}const image=await QRCode.toDataURL(latestQr,{width:720,margin:2,errorCorrectionLevel:'M'});response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar WhatsApp</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#07120e;color:#fff;font:16px system-ui"><main style="max-width:760px;padding:24px;text-align:center"><h1>Conectar o WhatsApp</h1><p>No segundo número: Dispositivos conectados → Conectar dispositivo.</p><img src="${image}" width="min(100%,720)" style="background:#fff;padding:16px;border-radius:18px"><p>Este QR expira rapidamente. Atualize esta página se necessário.</p></main></body></html>`);return}response.writeHead(200,{'content-type':'text/plain'});response.end('RankBall WhatsApp bot is running. Use /qr to connect.')}).listen(port,process.env.BOT_BIND_HOST||'0.0.0.0',()=>console.log(`Health server listening on ${port}`))

async function isAllowedGroup(jid){const{data,error}=await supabase.from('whatsapp_groups').select('id').eq('group_jid',jid).eq('active',true).limit(1);if(error)throw error;return Boolean(data?.length)}
async function sendUpdatedList(sock,link,chatJid,isGroup,matchId){
  let target=chatJid
  if(!isGroup){
    const{data:group,error}=await supabase.from('whatsapp_groups').select('group_jid').eq('organization_id',link.organization_id).eq('name','Terceiro Tempo FC').eq('active',true).maybeSingle()
    if(error)throw error
    if(!group)return
    target=group.group_jid
  }
  await sock.sendMessage(target,{text:await presenceListV2(link.organization_id,matchId)})
}
async function resolvePlayerLink(senderJids){
  const identities=[...new Set(senderJids.filter(Boolean))]
  for(const senderJid of identities){
    const{data:existing,error:existingError}=await supabase.from('whatsapp_player_links').select('organization_id,player_id').eq('whatsapp_jid',senderJid).eq('active',true).maybeSingle()
    if(existingError)throw existingError
    if(existing)return existing
  }
  const candidates=identities.flatMap(phoneCandidatesFromJid)
  if(!candidates.length)return null
  const{data:players,error}=await supabase.from('players').select('id,organization_id,phone').not('phone','is',null)
  if(error)throw error
  const player=(players||[]).find(item=>candidates.some(phone=>samePhone(item.phone,phone)))
  if(!player)return null
  const senderJid=identities[0]
  const{error:linkError}=await supabase.from('whatsapp_player_links').upsert({organization_id:player.organization_id,player_id:player.id,whatsapp_jid:senderJid,active:true,linked_at:new Date().toISOString()},{onConflict:'organization_id,player_id'})
  if(linkError)throw linkError
  return {organization_id:player.organization_id,player_id:player.id}
}
async function upcomingMatch(orgId){
  const{data,error}=await supabase.from('matches').select('id,starts_at').eq('organization_id',orgId).eq('status','SCHEDULED').gte('starts_at',new Date(Date.now()-4*60*60*1000).toISOString()).order('starts_at').limit(1).maybeSingle()
  if(error)throw error
  return data
}
async function updateAttendanceFromWhatsApp(link,status,messageId){
  const{data:logged,error:logError}=await supabase.from('whatsapp_message_log').select('message_id').eq('message_id',messageId).maybeSingle()
  if(logError)throw logError
  if(logged)return {ok:true,duplicate:true}
  const match=await upcomingMatch(link.organization_id)
  if(!match)return {ok:false,message:'Não há uma próxima partida agendada.'}
  const{error:attendanceError}=await supabase.from('match_attendance').upsert({match_id:match.id,player_id:link.player_id,status,source:'WHATSAPP',updated_at:new Date().toISOString()},{onConflict:'match_id,player_id'})
  if(attendanceError)throw attendanceError
  const{error:insertLogError}=await supabase.from('whatsapp_message_log').insert({message_id:messageId,organization_id:link.organization_id,sender_jid:'BOT_DIRECT',command:status,result:'APPLIED'})
  if(insertLogError)throw insertLogError
  return {ok:true,status,matchId:match.id}
}
async function addGuestFromWhatsApp(link,name,messageId){
  if(name.length<2)return {ok:false,message:'Use: !convidado Nome do convidado'}
  const{data:logged,error:logError}=await supabase.from('whatsapp_message_log').select('message_id').eq('message_id',messageId).maybeSingle();if(logError)throw logError;if(logged)return {ok:true,duplicate:true}
  const match=await upcomingMatch(link.organization_id);if(!match)return {ok:false,message:'Não há uma próxima partida agendada.'}
  const{error}=await supabase.from('match_guests').insert({match_id:match.id,invited_by_player_id:link.player_id,name,confirmed:true});if(error)throw error
  await supabase.from('whatsapp_message_log').insert({message_id:messageId,organization_id:link.organization_id,sender_jid:'whatsapp',command:'CONVIDADO',result:'APPLIED'})
  return {ok:true,matchId:match.id}
}
async function attendanceStatusFromWhatsApp(link){
  const match=await upcomingMatch(link.organization_id)
  if(!match)return {ok:false,message:'Não há uma próxima partida agendada.'}
  const{data,error}=await supabase.from('match_attendance').select('status').eq('match_id',match.id).eq('player_id',link.player_id).maybeSingle()
  if(error)throw error
  return {ok:true,status:data?.status||'PENDING'}
}
async function updateAttendanceFromPoll(link,matchId,status,pollId,voterJid){
  const logId=`poll:${pollId}:${voterJid}:${status}`
  const{data:alreadyLogged,error:lookupError}=await supabase.from('whatsapp_message_log').select('message_id').eq('message_id',logId).maybeSingle()
  if(lookupError)throw lookupError
  if(alreadyLogged)return false
  const{error}=await supabase.from('match_attendance').upsert({match_id:matchId,player_id:link.player_id,status,source:'WHATSAPP',updated_at:new Date().toISOString()},{onConflict:'match_id,player_id'})
  if(error)throw error
  const{error:logError}=await supabase.from('whatsapp_message_log').insert({message_id:logId,organization_id:link.organization_id,sender_jid:voterJid,command:status==='CONFIRMED'?'POLL_CONFIRM':'POLL_DECLINE',result:'APPLIED'})
  if(logError)throw logError
  return true
}
async function ensurePresencePolls(sock){
  const{data:groups,error:groupsError}=await supabase.from('whatsapp_groups').select('organization_id,group_jid').eq('name','Terceiro Tempo FC').eq('active',true)
  if(groupsError)throw groupsError
  for(const group of groups||[]){
    const match=await upcomingMatch(group.organization_id)
    if(!match)continue
    const marker=`PRESENCE_POLL:${match.id}`
    const{data:existing,error:existingError}=await supabase.from('whatsapp_message_log').select('message_id').eq('organization_id',group.organization_id).eq('sender_jid',group.group_jid).eq('command',marker).limit(1).maybeSingle()
    if(existingError)throw existingError
    if(existing)continue
    const date=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Bahia',weekday:'long',day:'2-digit',month:'2-digit'}).format(new Date(match.starts_at))
    const sent=await sock.sendMessage(group.group_jid,{poll:{name:`⚽ Presença — ${date}\nToque na sua resposta:`,values:['⚽ Vou jogar','❌ Não vou'],selectableCount:1}})
    presencePolls.set(sent.key.id,{message:sent,matchId:match.id,organizationId:group.organization_id,groupJid:group.group_jid})
    const{error:logError}=await supabase.from('whatsapp_message_log').insert({message_id:sent.key.id,organization_id:group.organization_id,sender_jid:group.group_jid,command:marker,result:'SENT'})
    if(logError)throw logError
  }
}
async function processListOutbox(sock){
  const{data:groups,error:groupsError}=await supabase.from('whatsapp_groups').select('organization_id,group_jid').eq('name','Terceiro Tempo FC').eq('active',true)
  if(groupsError)throw groupsError
  if(!groups?.length)return
  const{data:items,error}=await supabase.from('whatsapp_list_outbox').select('id,organization_id,match_id,group_jid').eq('status','PENDING').in('group_jid',groups.map(group=>group.group_jid)).order('requested_at').limit(10)
  if(error)throw error
  for(const item of items||[]){if(!groups.some(group=>group.organization_id===item.organization_id&&group.group_jid===item.group_jid))continue;try{await sock.sendMessage(item.group_jid,{text:await presenceListV2(item.organization_id,item.match_id)});await supabase.from('whatsapp_list_outbox').update({status:'SENT',sent_at:new Date().toISOString(),error:null}).eq('id',item.id)}catch(error){await supabase.from('whatsapp_list_outbox').update({status:'FAILED',error:error instanceof Error?error.message:'Falha ao enviar'}).eq('id',item.id)}}
}
async function processLists(sock){
  if(listProcessing||!whatsappConnected)return
  listProcessing=true
  try{await processListOutbox(sock)}finally{listProcessing=false}
}
async function presenceList(orgId){const{data:match,error}=await supabase.from('matches').select('id,starts_at').eq('organization_id',orgId).eq('status','SCHEDULED').gte('starts_at',new Date(Date.now()-4*60*60*1000).toISOString()).order('starts_at').limit(1).maybeSingle();if(error||!match)return '📋 Não há uma próxima partida agendada.';const[{data:players, error:playersError},{data:attendance,error:attendanceError},{data:guests,error:guestsError}]=await Promise.all([supabase.from('players').select('id,first_name,last_name,nickname,primary_position').eq('organization_id',orgId).eq('active',true).order('first_name'),supabase.from('match_attendance').select('player_id,status').eq('match_id',match.id),supabase.from('match_guests').select('name,invited_by_player_id,confirmed').eq('match_id',match.id)]);if(playersError||attendanceError||guestsError)throw playersError||attendanceError||guestsError;const date=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Bahia',weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(match.starts_at));const deadline=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Bahia',weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(match.starts_at));const attendanceByPlayer=new Map((attendance||[]).map(item=>[item.player_id,item.status]));const symbol=status=>status==='CONFIRMED'?'✅':status==='DECLINED'?'❌':'⏳';const name=player=>player.nickname||`${player.first_name} ${player.last_name}`.trim();const goalkeepers=(players||[]).filter(player=>/GOLEIR|GOALKEEPER/i.test(player.primary_position||''));const monthly=(players||[]).filter(player=>!/GOLEIR|GOALKEEPER/i.test(player.primary_position||''));const numbered=(items,render)=>items.length?items.map((item,index)=>`${index+1}. ${render(item)}`).join('\n'):'Nenhum cadastrado.';const playerLine=player=>`${name(player)} ${symbol(attendanceByPlayer.get(player.id))}`;const guestLine=guest=>{const inviter=(players||[]).find(player=>player.id===guest.invited_by_player_id);return `${guest.name}${inviter?` (${playerName(inviter)})`:''} ${guest.confirmed?'✅':'⏳'}`};return `📋 *Lista de Confirmação do Baba e Pagamento*\n*${date} — das 20:00 às 22:00*\nFavor confirmar presença até *${deadline} às 12:00*.\n\nSímbolos: ✅ Confirmado | ❌ Não vai | ⏳ A confirmar\n\n💵 *Mensalistas:*\n${numbered(monthly,playerLine)}\n\n🧤 *Goleiros:*\n_(Limite de 3 goleiros, por ordem de confirmação)_\n${numbered(goalkeepers,playerLine)}\n\n💵 *Convidados:*\n${numbered(guests||[],guestLine)}\n\nResponda *PRESENTE* ou *NÃO VOU* neste grupo.`}

async function presenceListV2(orgId,matchId=null){
  let query=supabase.from('matches').select('id,starts_at,ends_at,title').eq('organization_id',orgId);query=matchId?query.eq('id',matchId):query.eq('status','SCHEDULED').gte('starts_at',new Date(Date.now()-4*60*60*1000).toISOString()).order('starts_at').limit(1)
  const{data:match,error}=await query.maybeSingle()
  if(error||!match)return '📋 Não há uma próxima partida agendada.'
  const[{data:players,error:playersError},{data:attendance,error:attendanceError},{data:guests,error:guestsError}]=await Promise.all([
    supabase.from('players').select('id,first_name,last_name,nickname,primary_position').eq('organization_id',orgId).eq('active',true).order('first_name'),
    supabase.from('match_attendance').select('player_id,status').eq('match_id',match.id),
    supabase.from('match_guests').select('name,invited_by_player_id,confirmed').eq('match_id',match.id)
  ])
  if(playersError||attendanceError||guestsError)throw playersError||attendanceError||guestsError
  return formatPresenceList(match,players||[],attendance||[],guests||[])
}

async function sendAppUpdate(sock,row){if(row.source!=='APP')return;const{data:player}=await supabase.from('players').select('organization_id,first_name,nickname').eq('id',row.player_id).maybeSingle();if(!player)return;const status=row.status==='CONFIRMED'?'confirmou presença':row.status==='INJURED'?'informou lesão':'marcou ausência';const name=player.nickname||player.first_name;const{data:groups}=await supabase.from('whatsapp_groups').select('group_jid').eq('organization_id',player.organization_id).eq('name','Terceiro Tempo FC').eq('active',true);await Promise.all((groups||[]).map(group=>sock.sendMessage(group.group_jid,{text:`📋 ${name} ${status} pelo aplicativo.`})))}
async function announceWhatsappUpdate(sock,orgId,playerId,status){
  const{data:player,error:playerError}=await supabase.from('players').select('first_name,nickname').eq('id',playerId).maybeSingle()
  if(playerError)throw playerError
  if(!player)return
  const action=status==='CONFIRMED'?'confirmou presença':status==='DECLINED'?'informou ausência':'informou lesão'
  const{data:groups,error:groupsError}=await supabase.from('whatsapp_groups').select('group_jid').eq('organization_id',orgId).eq('name','Terceiro Tempo FC').eq('active',true)
  if(groupsError)throw groupsError
  const name=player.nickname||player.first_name
  await Promise.all((groups||[]).map(group=>sock.sendMessage(group.group_jid,{text:`📋 ${name} ${action}.`})))
}
async function sendCommandMenu(sock,jid){
  const listMessage=proto.Message.ListMessage.create({title:'⚽ *Comandos do RankBall*',description:'Escolha uma opção no menu:',buttonText:'Abrir comandos',footerText:'RankBall',listType:1,sections:[{title:'Presença',rows:[
    {title:'⚽ Confirmar presença',description:'Marcar que vai jogar',rowId:'!vou'},
    {title:'❌ Informar ausência',description:'Marcar que não vai jogar',rowId:'!naovou'},
    {title:'🩹 Informar lesão',description:'Marcar lesão',rowId:'!lesionado'}
  ]},{title:'Consultas',rows:[
    {title:'📋 Minha situação',description:'Ver seu status',rowId:'!status'},
    {title:'👥 Ver lista',description:'Ver lista de confirmação',rowId:'!lista'},
    {title:'🏓 Testar bot',description:'Verificar se o bot está online',rowId:'!ping'}
  ]}]})
  const message=generateWAMessageFromContent(jid,{listMessage},{userJid:sock.user?.id})
  await sock.relayMessage(jid,message.message,{messageId:message.key.id})
}
async function sendCommandMenuToActiveGroups(sock){
  const{data:groups,error}=await supabase.from('whatsapp_groups').select('group_jid').eq('name','Terceiro Tempo FC').eq('active',true)
  if(error)throw error
  await Promise.all((groups||[]).map(group=>sendCommandMenu(sock,group.group_jid)))
}

const bahiaParts=date=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Bahia',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]))
const playerName=player=>player.nickname||player.first_name
function pollOptionLabels(players){
  const names=players.map(player=>player.nickname||`${player.first_name||''} ${player.last_name||''}`.trim()).map(name=>name||'Jogador')
  const occurrences=new Map(names.map(name=>[name,0]))
  for(const name of names)occurrences.set(name,(occurrences.get(name)||0)+1)
  const used=new Map()
  return players.map((player,index)=>{
    const name=names[index]
    const base=occurrences.get(name)>1?`${name} (${player.primary_position||'posição não informada'})`:name
    const count=(used.get(base)||0)+1
    used.set(base,count)
    return {player,label:count>1?`${base} ${count}`:base}
  })
}
const categoryDefinitions=[
  {category:'DEFENDER',question:'🛡️ Melhor zagueiro da noite — escolha seu voto',matches:player=>/ZAGUEIR|DEFENSOR|DEFENDER|LATERAL/i.test(player.primary_position||'')},
  {category:'FORWARD',question:'⚽ Melhor atacante da noite — escolha seu voto',matches:player=>/ATAC|PONTA|CENTROAVANTE|FORWARD/i.test(player.primary_position||'')},
  {category:'MIDFIELDER',question:'🎯 Melhor meia da noite — escolha seu voto',matches:player=>/MEIA|VOLANTE|MEIO|MIDFIELD/i.test(player.primary_position||'')},
  {category:'GOALKEEPER',question:'🧤 Melhor goleiro da noite — escolha seu voto',matches:player=>/GOLEIR|GOALKEEPER/i.test(player.primary_position||'')}
]
async function mondayPlayers(orgId,babaDate){const start=new Date(`${babaDate}T00:00:00-03:00`).toISOString(),end=new Date(`${babaDate}T23:59:59.999-03:00`).toISOString();const{data:matches,error:matchesError}=await supabase.from('matches').select('id').eq('organization_id',orgId).gte('starts_at',start).lte('starts_at',end);if(matchesError)throw matchesError;const ids=(matches||[]).map(match=>match.id);if(!ids.length)return[];const{data:attendance,error:attendanceError}=await supabase.from('match_attendance').select('player_id').in('match_id',ids).eq('status','CONFIRMED');if(attendanceError)throw attendanceError;const playerIds=[...new Set((attendance||[]).map(item=>item.player_id))];if(!playerIds.length)return[];const{data:players,error:playersError}=await supabase.from('players').select('id,first_name,nickname,primary_position').in('id',playerIds).eq('organization_id',orgId);if(playersError)throw playersError;return players||[]}
async function ensurePolls(award,players){const{data:existing,error:existingError}=await supabase.from('weekly_award_polls').select('category').eq('award_id',award.id);if(existingError)throw existingError;const existingCategories=new Set((existing||[]).map(poll=>poll.category));for(const definition of categoryDefinitions){if(existingCategories.has(definition.category))continue;const candidates=players.filter(definition.matches).slice(0,12);const{data:poll,error}=await supabase.from('weekly_award_polls').insert({award_id:award.id,category:definition.category,question:definition.question,status:candidates.length>=2?'PENDING':'FAILED',error:candidates.length>=2?null:'Não há ao menos dois jogadores elegíveis.'}).select('id').single();if(error)throw error;if(candidates.length>=2){const options=pollOptionLabels(candidates).map(({player,label},index)=>({poll_id:poll.id,player_id:player.id,option_label:label,option_order:index+1}));const{error:optionsError}=await supabase.from('weekly_award_options').upsert(options,{onConflict:'poll_id,player_id'});if(optionsError)throw optionsError}}}
async function restoreAwardPolls(){
  const{data,error}=await supabase.from('weekly_award_polls').select('id,award_id,category,evolution_message_id,whatsapp_message,whatsapp_group_jid,weekly_award_options(player_id,option_label,option_order),weekly_awards!inner(status)').eq('status','SENT').in('weekly_awards.status',['SENT','PARTIAL','PREPARING']).not('whatsapp_message','is',null)
  if(error)throw error
  for(const poll of data||[])if(poll.evolution_message_id)awardPolls.set(poll.evolution_message_id,{message:restorePollMessage(poll.whatsapp_message),pollId:poll.id,awardId:poll.award_id,category:poll.category,groupJid:poll.whatsapp_group_jid,options:poll.weekly_award_options||[]})
}
async function sendPendingPolls(sock,award,groupJid){
  const categories=categoryDefinitions.map(definition=>definition.category)
  const{data:polls,error}=await supabase.from('weekly_award_polls').select('id,category,question,status,weekly_award_options(player_id,option_label,option_order)').eq('award_id',award.id).eq('status','PENDING').in('category',categories)
  if(error)throw error
  for(const poll of polls||[]){
    const options=(poll.weekly_award_options||[]).sort((a,b)=>a.option_order-b.option_order)
    const values=options.map(option=>option.option_label)
    if(values.length<2)continue
    const sent=await sock.sendMessage(groupJid,{poll:{name:poll.question,values,selectableCount:1}})
    const{error:updateError}=await supabase.from('weekly_award_polls').update({status:'SENT',sent_at:new Date().toISOString(),evolution_message_id:sent.key.id,whatsapp_message:serializePollMessage(sent),whatsapp_group_jid:groupJid,error:null}).eq('id',poll.id)
    if(updateError)throw updateError
    awardPolls.set(sent.key.id,{message:sent,pollId:poll.id,awardId:award.id,category:poll.category,groupJid,options})
  }
  const{data:pending,error:pendingError}=await supabase.from('weekly_award_polls').select('id').eq('award_id',award.id).eq('status','PENDING').in('category',categories).limit(1)
  if(pendingError)throw pendingError
  const{error:awardError}=await supabase.from('weekly_awards').update({status:pending?.length?'PARTIAL':'SENT',sent_at:new Date().toISOString()}).eq('id',award.id).neq('status','CLOSED')
  if(awardError)throw awardError
}
async function runMondayAutomation(sock){if(!whatsappConnected)return;const now=bahiaParts(new Date());if(now.weekday!=='Mon'||now.hour!=='23')return;const babaDate=`${now.year}-${now.month}-${now.day}`;const{data:groups,error:groupsError}=await supabase.from('whatsapp_groups').select('organization_id,group_jid').eq('name','Terceiro Tempo FC').eq('active',true);if(groupsError)throw groupsError;for(const group of groups||[]){const{data:award,error:awardError}=await supabase.from('weekly_awards').upsert({organization_id:group.organization_id,baba_date:babaDate},{onConflict:'organization_id,baba_date'}).select('id,organization_id,baba_date').single();if(awardError)throw awardError;const players=await mondayPlayers(group.organization_id,babaDate);await ensurePolls(award,players);await sendPendingPolls(sock,award,group.group_jid)}}
async function finalizeWeeklyAwards(sock){
  const{data:awards,error}=await supabase.from('weekly_awards').select('id,organization_id,baba_date,status').in('status',['SENT','PARTIAL'])
  if(error)throw error
  for(const award of awards||[]){
    const votingEndsAt=new Date(`${award.baba_date}T08:00:00-03:00`);votingEndsAt.setUTCDate(votingEndsAt.getUTCDate()+1);if(new Date()<votingEndsAt)continue
    const{data:legacy,error:legacyError}=await supabase.from('weekly_award_polls').select('id').eq('award_id',award.id).eq('status','SENT').is('whatsapp_message',null).limit(1)
    if(legacyError)throw legacyError
    if(legacy?.length){console.error('Apuração suspensa: enquete antiga sem dados para recuperar os votos.',award.id);continue}
    const{error:closeError}=await supabase.rpc('close_weekly_award',{target_award:award.id})
    if(closeError)throw closeError
  }
  const{data:announcements,error:announcementsError}=await supabase.from('weekly_awards').select('id,organization_id,tally_results').eq('status','CLOSED').not('tally_results','is',null).is('tally_announced_at',null)
  if(announcementsError)throw announcementsError
  const labels={DEFENDER:'🛡️ Melhor zagueiro',FORWARD:'⚽ Melhor atacante',MIDFIELDER:'🎯 Melhor meia',GOALKEEPER:'🧤 Melhor goleiro'}
  for(const award of announcements||[]){
    const results=award.tally_results||[]
    const text=results.length?`🏅 *Resultado da votação*\n\n${results.map(result=>`${labels[result.category]}: *${result.name}* (${result.votes} voto${result.votes===1?'':'s'})`).join('\n')}\n\nEm caso de empate, todos os empatados recebem a conquista.`:'🏅 A votação foi encerrada sem votos.'
    const{data:groups,error:groupsError}=await supabase.from('whatsapp_groups').select('group_jid').eq('organization_id',award.organization_id).eq('name','Terceiro Tempo FC').eq('active',true)
    if(groupsError)throw groupsError
    if(!groups?.length)continue
    for(const group of groups)await sock.sendMessage(group.group_jid,{text})
    const{error:updateError}=await supabase.from('weekly_awards').update({tally_announced_at:new Date().toISOString()}).eq('id',award.id)
    if(updateError)throw updateError
  }
}
async function finishMatchesAt2230(){
  const now=bahiaParts(new Date())
  if(Number(now.hour)<22||(Number(now.hour)===22&&Number(now.minute)<30))return
  const day=`${now.year}-${now.month}-${now.day}`
  const start=new Date(`${day}T00:00:00-03:00`).toISOString()
  const end=new Date(`${day}T23:59:59.999-03:00`).toISOString()
  const{data:matches,error}=await supabase.from('matches').select('id').eq('status','LIVE').gte('starts_at',start).lte('starts_at',end)
  if(error)throw error
  for(const match of matches||[]){const{error:updateError}=await supabase.from('matches').update({status:'FINISHED'}).eq('id',match.id).eq('status','LIVE');if(updateError)throw updateError}
}
async function sendAwardPollTest(sock,onlyCategory=null){
  const{data:group,error}=await supabase.from('whatsapp_groups').select('group_jid,organization_id').eq('name','wswew').eq('active',true).maybeSingle()
  if(error||!group)throw error||new Error('Grupo de teste wswew não encontrado.')
  const{data:players,error:playersError}=await supabase.from('players').select('first_name,last_name,nickname,primary_position').eq('organization_id',group.organization_id).eq('active',true).order('first_name')
  if(playersError)throw playersError
  for(const definition of categoryDefinitions.filter(definition=>!onlyCategory||definition.category===onlyCategory)){
    const values=pollOptionLabels((players||[]).filter(definition.matches)).map(option=>option.label)
    if(values.length<2){await sock.sendMessage(group.group_jid,{text:`🧪 TESTE — ${definition.question}\nNão há ao menos dois jogadores cadastrados nesta posição.`});console.log(`Teste ${definition.category}: candidatos insuficientes.`);continue}
    const pageCount=Math.ceil(values.length/12)
    const pages=Array.from({length:pageCount},(_,index)=>values.slice(Math.floor(index*values.length/pageCount),Math.floor((index+1)*values.length/pageCount)))
    for(const [index,page] of pages.entries()){await sock.sendMessage(group.group_jid,{poll:{name:`🧪 TESTE — ${definition.question}${pages.length>1?` (${index+1}/${pages.length})`:''}\nNão altera dados do RankBall.`,values:page,selectableCount:1}});console.log(`Teste ${definition.category}: enquete ${index+1}/${pages.length} enviada com ${page.length} opções.`)}
  }
}
async function runAwardTallyTest(sock,minutes){
  const{data:group,error}=await supabase.from('whatsapp_groups').select('group_jid,organization_id').eq('name','wswew').eq('active',true).maybeSingle()
  if(error||!group)throw error||new Error('Grupo de teste wswew não encontrado.')
  const{data:players,error:playersError}=await supabase.from('players').select('id,first_name,last_name,nickname,primary_position').eq('organization_id',group.organization_id).eq('active',true).order('first_name')
  if(playersError)throw playersError
  await sock.sendMessage(group.group_jid,{text:`🧪 *Teste de apuração*\nVotem nas enquetes abaixo. A votação ficará aberta por ${minutes} minutos após o envio da última enquete. Os resultados não alteram os rankings.`})
  const polls=[]
  for(const definition of categoryDefinitions){
    const values=pollOptionLabels((players||[]).filter(definition.matches).slice(0,12)).map(option=>option.label)
    if(values.length<2){await sock.sendMessage(group.group_jid,{text:`🧪 ${definition.question}: jogadores insuficientes para o teste.`});continue}
    const sent=await sock.sendMessage(group.group_jid,{poll:{name:`🧪 TESTE — ${definition.question}`,values,selectableCount:1}})
    const poll={message:sent,category:definition.category}
    testAwardPolls.set(sent.key.id,poll);polls.push(poll)
    console.log(`Apuração de teste: ${definition.category} enviada.`)
  }
  setTimeout(async()=>{
    try{
      const labels={DEFENDER:'🛡️ Zagueiro',FORWARD:'⚽ Atacante',MIDFIELDER:'🎯 Meia',GOALKEEPER:'🧤 Goleiro'}
      const lines=polls.map(poll=>{
        const votes=getAggregateVotesInPollMessage(poll.message,sock.user?.id)
        const highest=Math.max(0,...votes.map(option=>option.voters.length))
        if(!highest)return `${labels[poll.category]}: sem votos`
        const winners=votes.filter(option=>option.voters.length===highest).map(option=>option.name).join(', ')
        return `${labels[poll.category]}: *${winners}* — ${highest} voto${highest===1?'':'s'}${votes.filter(option=>option.voters.length===highest).length>1?' (empate)':''}`
      })
      if(!currentSocket||!whatsappConnected)throw new Error('WhatsApp desconectado na hora da apuração.')
      await currentSocket.sendMessage(group.group_jid,{text:`🧪 *Resultado da apuração de teste*\n\n${lines.join('\n')}\n\nTeste concluído. Nenhum ranking foi alterado.`})
      console.log('Resultado da apuração de teste enviado.')
    }catch(error){console.error('Falha na apuração de teste:',error)}
    finally{for(const [id,poll] of testAwardPolls)if(polls.includes(poll))testAwardPolls.delete(id)}
  },minutes*60_000)
}

const attendanceReply={CONFIRMED:'⚽ Presença confirmada no RankBall.',DECLINED:'❌ Ausência registrada no RankBall.',INJURED:'🩹 Lesão registrada no RankBall.'}
const statusReply={CONFIRMED:'✅ presença confirmada',DECLINED:'❌ ausência informada',INJURED:'🩹 lesionado',PENDING:'⏳ aguardando confirmação'}
function scheduleReconnect(){
  if(shuttingDown||reconnectTimer)return
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;start().catch(error=>console.error('Falha ao reconectar o WhatsApp:',error))},3000)
}
async function start(){
  if(shuttingDown)return
  await restoreAwardPolls()
  const{state,saveCreds}=process.env.BOT_AUTH_STORE==='supabase'?await useSupabaseAuthState(supabase,process.env.BOT_SESSION_ID||'rankball'):await useMultiFileAuthState(authDir)
  const{version}=await fetchLatestBaileysVersion()
  const sock=makeWASocket({version,logger,auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,logger)},markOnlineOnConnect:false,getMessage:async key=>presencePolls.get(key.id)?.message?.message||awardPolls.get(key.id)?.message?.message||testAwardPolls.get(key.id)?.message?.message})
  currentSocket=sock
  sock.ev.on('creds.update',saveCreds)
  sock.ev.on('connection.update',({connection,lastDisconnect,qr})=>{
    if(qr){latestQr=qr;qrcode.generate(qr,{small:true});console.log('Abra /qr no link local para ler o QR como imagem.')}
    if(connection==='close'){whatsappConnected=false;if(currentSocket===sock)currentSocket=null;const code=new Boom(lastDisconnect?.error)?.output.statusCode;if(code!==DisconnectReason.loggedOut)scheduleReconnect();else console.error('Sessão desconectada. Apague auth_info e leia o novo QR.')}
    if(connection==='open'){whatsappConnected=true;latestQr='';console.log('Bot RankBall conectado ao WhatsApp.');runMondayAutomation(sock).catch(error=>console.error('Falha na automação de segunda:',error));finalizeWeeklyAwards(sock).catch(error=>console.error('Falha ao finalizar votação semanal:',error));finishMatchesAt2230().catch(error=>console.error('Falha ao encerrar partidas às 22h30:',error));ensurePresencePolls(sock).catch(error=>console.error('Falha ao criar enquete de presença:',error));if(process.env.TEST_TALLY_MINUTES){const minutes=Number(process.env.TEST_TALLY_MINUTES);process.env.TEST_TALLY_MINUTES='';if(minutes>0)runAwardTallyTest(sock,minutes).catch(error=>console.error('Falha ao iniciar apuração de teste:',error))}if(process.env.SEND_MENU_ON_START==='true'){process.env.SEND_MENU_ON_START='false';sendCommandMenuToActiveGroups(sock).catch(error=>console.error('Falha ao enviar menu ao grupo:',error))}if(process.env.SEND_AWARD_TEST_GROUP==='true'){process.env.SEND_AWARD_TEST_GROUP='false';sendAwardPollTest(sock).catch(error=>console.error('Falha ao enviar enquete de teste:',error))}if(process.env.SEND_AWARD_TEST_CATEGORY){const category=process.env.SEND_AWARD_TEST_CATEGORY;process.env.SEND_AWARD_TEST_CATEGORY='';sendAwardPollTest(sock,category).catch(error=>console.error('Falha ao enviar enquete de teste por posição:',error))}}
  })
  sock.ev.on('messages.upsert',async({messages,type})=>{
    if(type!=='notify')return
    for(const message of messages){
      if(!message.message||!message.key.remoteJid)continue
      try{if(await processEncryptedPollVote(sock,message))continue}catch(error){console.error('Falha ao processar voto recebido:',error);continue}
      const chatJid=message.key.remoteJid
      const command=parseCommand(textOf(message.message))
      if(!command)continue
      const isGroup=chatJid.endsWith('@g.us')
      console.log(`Comando ${command} recebido em ${isGroup?'grupo':'conversa privada'}.`)
      try{
        if(isGroup&&!await isAllowedGroup(chatJid)){console.warn('Grupo não autorizado:',chatJid);continue}
        // !ping é um teste de conectividade; não requer cadastro de jogador.
        if(command==='PING'){await sock.sendMessage(chatJid,{text:'🏓 pong! O bot RankBall está online.'});continue}
        if(command==='AJUDA'||command==='MENU'){await sock.sendMessage(chatJid,{text:helpMessage()});continue}
        const senderJids=[message.key.participantAlt,message.key.participant,chatJid].filter(Boolean)
        const phoneJids=(await Promise.all(senderJids.map(async jid=>{
          if(!jid.endsWith('@lid'))return null
          try{return await sock.signalRepository.lidMapping.getPNForLID(jid)}catch(error){console.error('Falha ao identificar número do remetente:',error);return null}
        }))).filter(Boolean)
        const senderIdentities=[...new Set([...senderJids,...phoneJids])]
        const link=await resolvePlayerLink(senderIdentities)
        if(!link){await sock.sendMessage(chatJid,{text:'Seu número ainda não está vinculado a um jogador. Peça ao administrador.'});continue}
        if(isGroup){const{data:group,error}=await supabase.from('whatsapp_groups').select('id').eq('group_jid',chatJid).eq('organization_id',link.organization_id).eq('active',true).maybeSingle();if(error)throw error;if(!group){await sock.sendMessage(chatJid,{text:'Seu cadastro não pertence à organização deste grupo.'});continue}}
        if(command==='CONVIDADO'){const data=await addGuestFromWhatsApp(link,guestNameFromCommand(textOf(message.message)),message.key.id);if(!data.duplicate){await sock.sendMessage(chatJid,{text:data.ok?'👤 Convidado adicionado à lista.':data.message});if(data.ok)await sendUpdatedList(sock,link,chatJid,isGroup,data.matchId)}continue}
        if(command==='LISTA'){await sock.sendMessage(chatJid,{text:await presenceListV2(link.organization_id)});continue}
        if(command==='STATUS'){
          const data=await attendanceStatusFromWhatsApp(link)
          await sock.sendMessage(chatJid,{text:data.ok?`📋 Seu status: *${statusReply[data.status]||'aguardando confirmação'}*.`:data.message})
          continue
        }
        const status=command==='VOU'?'CONFIRMED':command==='NAOVOU'?'DECLINED':'INJURED'
        const data=await updateAttendanceFromWhatsApp(link,status,message.key.id)
        if(data.duplicate)continue
        await sock.sendMessage(chatJid,{text:data.ok?attendanceReply[data.status]:data.message})
        if(data.ok)await sendUpdatedList(sock,link,chatJid,isGroup,data.matchId).catch(error=>console.error('Presença registrada, mas houve falha ao enviar a lista:',error))
      }catch(error){console.error('Falha ao processar comando:',error);await sock.sendMessage(chatJid,{text:'Não consegui atualizar agora. Tente novamente em instantes.'})}
    }
  })
  sock.ev.on('messages.update',async updates=>{
    for(const update of updates){
      const awardPoll=awardPolls.get(update.key.id)
      const testAwardPoll=testAwardPolls.get(update.key.id)
      const poll=presencePolls.get(update.key.id)
      const pollUpdates=update.update.pollUpdates
      if((!poll&&!awardPoll&&!testAwardPoll)||!pollUpdates?.length)continue
      try{
        if(testAwardPoll){for(const pollUpdate of pollUpdates)updateMessageWithPollUpdate(testAwardPoll.message,pollUpdate);continue}
        if(awardPoll){
          const previous=awardVoteQueues.get(awardPoll.pollId)||Promise.resolve()
          const work=previous.catch(()=>{}).then(async()=>{
            const next=restorePollMessage(serializePollMessage(awardPoll.message))
            for(const pollUpdate of pollUpdates)updateMessageWithPollUpdate(next,pollUpdate)
            const votes=getAggregateVotesInPollMessage(next,sock.user?.id)
            const rows=[]
            for(const vote of votes){
              const option=awardPoll.options.find(item=>item.option_label===vote.name)
              if(!option)continue
              for(const voter of vote.voters){
                const phoneJid=voter.endsWith('@lid')?await sock.signalRepository.lidMapping.getPNForLID(voter):null
                const voterLink=await resolvePlayerLink([voter,phoneJid].filter(Boolean))
                rows.push({player_id:option.player_id,voter_player_id:voterLink?.player_id||null,whatsapp_voter_id:voter})
              }
            }
            const{data,error}=await supabase.rpc('sync_award_poll_votes',{target_poll:awardPoll.pollId,message_snapshot:serializePollMessage(next),votes:rows})
            if(error)throw error
            if(data)awardPoll.message=next
          })
          awardVoteQueues.set(awardPoll.pollId,work)
          try{await work}finally{if(awardVoteQueues.get(awardPoll.pollId)===work)awardVoteQueues.delete(awardPoll.pollId)}
          continue
        }
        for(const pollUpdate of pollUpdates)updateMessageWithPollUpdate(poll.message,pollUpdate)
        const votes=getAggregateVotesInPollMessage(poll.message,sock.user?.id)
        for(const vote of votes){
          const status=vote.name.includes('Vou jogar')?'CONFIRMED':vote.name.includes('Não vou')?'DECLINED':null
          if(!status)continue
          for(const voter of vote.voters){
            const voteKey=`${update.key.id}:${voter}`
            if(presencePollVotes.get(voteKey)===status)continue
            const phoneJid=voter.endsWith('@lid')?await sock.signalRepository.lidMapping.getPNForLID(voter):null
            const link=await resolvePlayerLink([voter,phoneJid].filter(Boolean))
            if(!link)continue
            const applied=await updateAttendanceFromPoll(link,poll.matchId,status,update.key.id,voter)
            presencePollVotes.set(voteKey,status)
            if(!applied)continue
            const{data:player}=await supabase.from('players').select('first_name,nickname').eq('id',link.player_id).maybeSingle()
            const name=player?.nickname||player?.first_name||'Jogador'
            await sock.sendMessage(poll.groupJid,{text:status==='CONFIRMED'?`✅ ${name} confirmou presença.`:`❌ ${name} informou ausência.`})
          }
        }
      }catch(error){console.error('Falha ao processar voto da enquete:',error)}
    }
  })
  if(!realtimeChannel)realtimeChannel=supabase.channel('rankball-app-presence').on('postgres_changes',{event:'*',schema:'public',table:'match_attendance'},payload=>{if(currentSocket)sendAppUpdate(currentSocket,payload.new).catch(error=>console.error('Falha ao enviar atualização do app:',error))}).subscribe()
  if(!automationTimer)automationTimer=setInterval(()=>{if(currentSocket){runMondayAutomation(currentSocket).catch(error=>console.error('Falha na automação de segunda:',error));ensurePresencePolls(currentSocket).catch(error=>console.error('Falha ao criar enquete de presença:',error))}},60*60*1000)
  if(!awardResultTimer)awardResultTimer=setInterval(()=>{if(currentSocket){finalizeWeeklyAwards(currentSocket).catch(error=>console.error('Falha ao finalizar votação semanal:',error));finishMatchesAt2230().catch(error=>console.error('Falha ao encerrar partidas às 22h30:',error));processLists(currentSocket).catch(error=>console.error('Falha ao enviar lista:',error))}},60_000)
}
process.once('SIGINT',async()=>{shuttingDown=true;if(reconnectTimer)clearTimeout(reconnectTimer);if(automationTimer)clearInterval(automationTimer);if(awardResultTimer)clearInterval(awardResultTimer);if(realtimeChannel)await supabase.removeChannel(realtimeChannel);process.exit(0)})
start().catch(error=>{console.error(error);process.exit(1)})
