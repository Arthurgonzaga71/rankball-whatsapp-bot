export function formatPresenceList(match, players, attendance, guests) {
  const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' })
  const [weekday, date] = dateFormat.format(new Date(match.starts_at)).split(', ')
  const day = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} (${date})`
  const hour = value => timeFormat.format(new Date(value)).replace(':00', 'h')
  const status = new Map(attendance.map(item => [item.player_id, item.status]))
  const symbol = value => value === 'CONFIRMED' ? ' ✅' : value === 'DECLINED' ? ' ❌' : value === 'INJURED' ? ' 🚑' : ''
  const name = player => player.nickname || `${player.first_name} ${player.last_name}`.trim()
  const isGoalkeeper = player => /GOLEIR|GOALKEEPER/i.test(player.primary_position || '')
  const numbered = (items, render) => items.map((item, index) => `${index + 1}. ${render(item)}`).join('\n')
  const monthly = numbered(players.filter(player => !isGoalkeeper(player)), player => `${name(player)}${symbol(status.get(player.id))}`)
  const keepers = numbered(players.filter(isGoalkeeper), player => `🧤 ${name(player)}${symbol(status.get(player.id))}`)
  const invited = numbered(guests, guest => `${guest.name}${guest.confirmed ? ' ✅' : ''}`)
  return `📋 *Lista de Confirmação — ${day}, das ${hour(match.starts_at)} às ${match.ends_at ? hour(match.ends_at) : '22h'}*\nConfirmar presença até ${day}, às 12:00h.\n\n*Comandos:*\n\n!vou ou !euvou - Para confirmar ✅\n!naovou - Para ausentar ❌\n!lesao - Para informar lesão 🚑\n!convidado Nome do convidado - Para indicar 👦\n!lista - Para consultar a lista\n\n💵 *Mensalistas:*\n\n${monthly}\n\n🧤 *Goleiros:*\n(Limite de 3 goleiros, por ordem de marcação)\n\n${keepers}\n\n💵 *Convidados:*\n\n${invited}`
}
