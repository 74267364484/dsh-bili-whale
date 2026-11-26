// Exit contract: 0 = message/ack/baseline; 1 + {hit:false} = normal empty; 2 = invalid input; 3 = failure.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {config} from '../lib/config.mjs'
import {readHistory} from '../lib/dm-history.mjs'
import {acquireProcessLock} from '../lib/process-lock.mjs'
import {readJsonState, writeWithBackup} from '../lib/durable-write.mjs'
const argv=process.argv.slice(2),peek=argv.includes('--peek'),json=argv.includes('--json')
const owner=String(config().owner?.mid??'').trim(),name=String(config().owner?.name??'主人')
const home=process.env.USERPROFILE||process.env.HOME||'/'
const file=path.join(home,'.bili-ai/dm-await-state.json')
function save(state) {
  // 2026-11-26：fsync 落盘 + 留 .bak；断电把主文件写成全 NUL 时不再把私信轮询永久卡死
  writeWithBackup(file,JSON.stringify(state,null,2))
}
function acknowledge(state,message) {
  const same=Number(state.lastSeen)===message.ts
  return {...state,owner,lastSeen:message.ts,lastKey:message.key,lastKeys:[...new Set([...(same?(state.lastKeys??(state.lastKey?[state.lastKey]:[])):[]),message.key])],pending:undefined,queue:state.queue??[],at:new Date().toISOString()}
}
function emit(message){console.log(json?JSON.stringify(message):'DM_HIT mid='+owner+' text='+message.text)}
async function main(){
  if(!owner){console.error('配置里 owner.mid 为空');return 2}
  // 2026-11-26：状态文件坏了 → 先读 .bak；主备都坏 → 隔离坏文件，按"基线"自愈（把当前最新一条标记为已读），
  //   不再抛错让 dmTick 每轮都失败（11-10 那次就是这么静默了 16 天）。
  const loaded=readJsonState(file)
  let state=loaded.state
  const reset=loaded.source==='reset'
  if(loaded.recovered)console.error(`[dm-await] 私信状态损坏（source=${loaded.source}），已自愈${loaded.quarantined?.length?'：坏文件留档 '+loaded.quarantined.join(' , '):''}`)
  if(state.owner&&state.owner!==owner)state={}
  if(state.lastSeen!==undefined&&(!Number.isFinite(Number(state.lastSeen))||Number(state.lastSeen)<0))throw Error('私信游标损坏，已停止读取')
  if(state.queue!==undefined&&!Array.isArray(state.queue))throw Error('私信待交付队列损坏')
  const baselineMode=argv.includes('--baseline')||reset
  const ackIndex=argv.indexOf('--ack')
  if(ackIndex>=0){
    if(!state.pending||state.pending.mid!==owner||state.pending.receipt!==argv[ackIndex+1]){console.error('私信确认凭据不匹配，未推进已读状态');return 2}
    save(acknowledge(state,state.pending));console.log('私信交付已确认');return 0
  }
  if(state.pending?.mid===owner&&!baselineMode){emit(state.pending);return 0}
  if(!state.queue?.length||baselineMode){
    const cred=JSON.parse(fs.readFileSync(path.join(home,'.bili-ai/credentials.json'),'utf8'))
    const headers={'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/',cookie:'SESSDATA='+cred.sessdata+'; bili_jct='+cred.bili_jct+'; buvid3='+cred.buvid3}
    const result=await readHistory(owner,headers,state,{baseline:baselineMode})
    if(baselineMode){
      const latest=result.all.at(-1),ts=latest?.ts??0
      save({owner,lastSeen:ts,lastKey:latest?.key,lastKeys:result.all.filter(r=>r.ts===ts).map(r=>r.key),lastIncoming:state.lastIncoming,queue:[]})
      console.log(reset?'私信状态已重建（损坏自愈，按当前最新一条记为已读）':'已把当前私信状态标记为已读');return 0
    }
    state={...state,owner,queue:result.messages,lastIncoming:Math.max(Number(state.lastIncoming??0),...result.messages.map(r=>r.ts))}
    save(state)
  }
  if(!state.queue.length){console.log(json?JSON.stringify({hit:false}):'无新私信');return 1}
  const [row,...rest]=state.queue
  const message={hit:true,mid:owner,name,text:row.text,ts:row.ts,key:row.key,receipt:crypto.randomUUID()}
  state={...state,owner,queue:rest}
  if(peek)save({...state,pending:message})
  else save(acknowledge(state,message))
  emit(message);return 0
}
let release
try{
  fs.mkdirSync(path.dirname(file),{recursive:true})
  release=await acquireProcessLock(file)
  process.exitCode=await main()
}catch(e){console.error(e.message);process.exitCode=3}
finally{if(release)await release()}
