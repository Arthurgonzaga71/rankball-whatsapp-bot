const aliases=new Map([
  ['PING','PING'],['PONG','PING'],['VOU','VOU'],['EUVOU','VOU'],['EU VOU','VOU'],['PRESENTE','VOU'],['CONFIRMO','VOU'],['SIM','VOU'],
  ['NAOVOU','NAOVOU'],['NAO VOU','NAOVOU'],['AUSENTE','NAOVOU'],['NAO','NAOVOU'],
  ['LESIONADO','LESIONADO'],['LESIONADA','LESIONADO'],['LESIONEI','LESIONADO'],['LESAO','LESIONADO'],['DOENTE','LESIONADO'],
  ['STATUS','STATUS'],['LISTA','LISTA'],['AJUDA','AJUDA'],['MENU','MENU']
])

export function parseCommand(input){
  const normalized=String(input||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase()
  if(!normalized)return null
  const command=normalized.startsWith('!')?normalized.slice(1).trim():normalized
  if(command.startsWith('CONVIDADO '))return 'CONVIDADO'
  return aliases.get(command)||null
}

export function guestNameFromCommand(input){const text=String(input||'').trim().replace(/^!\s*/,'');const match=text.match(/^convidado\s+(.+)$/i);return (match?.[1].trim()||'').replace(/^["“”']|["“”']$/g,'').trim()}

export function helpMessage(){
  return '⚽ *Comandos do RankBall*\n\n!euvou ou !vou — confirmar presença\n!naovou ou !não vou — informar ausência\n!doente ou !lesão — informar lesão/doença\n!convidado Nome — adicionar convidado\n!status — consultar sua situação\n!lista — consultar a lista\n!ping — testar o bot'
}

export function phoneCandidatesFromJid(jid){
  const digits=String(jid||'').split('@')[0].split(':')[0].replace(/\D/g,'')
  if(digits.length<10)return []
  return [...new Set([digits,digits.startsWith('55')?digits.slice(2):`55${digits}`].filter(value=>value.length>=10))]
}

export function samePhone(left,right){
  const normalize=value=>String(value||'').replace(/\D/g,'').replace(/^55(?=\d{10,11}$)/,'')
  const withoutNinthDigit=value=>value.length===11&&value[2]==='9'?`${value.slice(0,2)}${value.slice(3)}`:value
  const normalizedLeft=normalize(left),normalizedRight=normalize(right)
  return normalizedLeft.length>=10&&(
    normalizedLeft===normalizedRight||
    withoutNinthDigit(normalizedLeft)===withoutNinthDigit(normalizedRight)
  )
}
