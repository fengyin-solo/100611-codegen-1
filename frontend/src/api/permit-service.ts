import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// —— 数据集合 ——
export const PERMIT_KEY = 'permit' // 作业票
export const GASCHECK_KEY = 'gascheck' // 气体检测原始记录
export const GUARDIAN_KEY = 'guardian' // 监护人签到原始记录
const OPS_KEY = 'permitops' // 幂等操作日志：同一 requestId 只生效一次
const SAFETY_KEY = 'safety' // 安全巡检整改台账（签发、终结的结论落这里）

// 状态机：只能顺着 申请→待检测→已签发→作业中→终结归档 逐级往下转，不许跳级。
export const PERMIT_STATUSES = ['申请', '待检测', '已签发', '作业中', '终结归档']
const NEXT_STEP: Record<string, { action: string; target: string }> = {
  申请: { action: '送检', target: '待检测' },
  待检测: { action: '签发', target: '已签发' },
  已签发: { action: '开工', target: '作业中' },
  作业中: { action: '终结', target: '终结归档' },
}

// 冲突裁决约定：以数据层已落库的状态为准，先落库者为准；后到且冲突的请求当场驳回，不改写已有结论。
// 共用监护人裁决：受限空间优先于动火（舱内气体环境随时间变化、检测结论时效短、救援难度大，
// 动火作业环境相对开放、可延后）；同类型按申请先后（票号小者优先）。裁决理由写进签发说明。

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function today(): string {
  return new Date().toLocaleDateString('sv')
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const match = String(row[field] ?? '').match(new RegExp(`^${prefix}-(\\d+)$`))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

// —— 事务：落库不成就整套撤回 ——
const TX_KEYS = [PERMIT_KEY, GASCHECK_KEY, GUARDIAN_KEY, OPS_KEY, SAFETY_KEY]

function withTransaction(fn: () => ActionResult): ActionResult {
  const snapshot = TX_KEYS.map(
    (key) => [key, JSON.parse(JSON.stringify(listRows(key))) as EntryRow[]] as const,
  )
  try {
    return fn()
  } catch (error) {
    for (const [key, rows] of snapshot) {
      saveRows(key, rows)
    }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `落库失败，已整套撤回：${reason}` }
  }
}

// —— 幂等：同一 requestId 的重复提交按首次结果处理，不再变更数据 ——
function replayIfSeen(requestId: string): ActionResult | null {
  const hit = listRows(OPS_KEY).find((row) => String(row.requestId) === requestId)
  if (!hit) {
    return null
  }
  return {
    ok: String(hit.okFlag) === 'true',
    message: `重复提交（${requestId}），按首次结果处理、不再变更：${String(hit.结果)}`,
  }
}

function recordOp(requestId: string, ok: boolean, message: string): void {
  const rows = listRows(OPS_KEY)
  rows.push({
    id: nextId(rows),
    status: '已记录',
    pending: false,
    abnormal: false,
    requestId,
    okFlag: String(ok),
    时间: now(),
    结果: message,
  })
  saveRows(OPS_KEY, rows)
}

// —— 原始记录取数：气体检测结论、监护人签到都只认原始记录 ——
type GasState =
  | { state: 'none' }
  | { state: 'pending'; ref: string }
  | { state: 'done'; conclusion: string; ref: string }

function gasConclusionOf(code: string): GasState {
  const records = listRows(GASCHECK_KEY).filter((row) => String(row.作业票编号) === code)
  if (!records.length) {
    return { state: 'none' }
  }
  const done = [...records].reverse().find((row) => String(row.检测结论 ?? '').trim() !== '')
  if (done) {
    return { state: 'done', conclusion: String(done.检测结论), ref: String(done.检测编号) }
  }
  return { state: 'pending', ref: String(records[records.length - 1].检测编号) }
}

function guardianSigned(code: string, guardian: string): boolean {
  return listRows(GUARDIAN_KEY).some(
    (row) => String(row.作业票编号) === code && String(row.监护人) === guardian,
  )
}

// —— 共用监护人裁决 ——
function typeRank(type: string): number {
  return type === '受限空间' ? 0 : 1
}

function higherPriority(a: EntryRow, b: EntryRow): EntryRow {
  const rankDiff = typeRank(String(a.作业类型)) - typeRank(String(b.作业类型))
  if (rankDiff !== 0) {
    return rankDiff < 0 ? a : b
  }
  return Number(a.id) <= Number(b.id) ? a : b
}

function arbitrationNote(permit: EntryRow, permits: EntryRow[]): string {
  const rivals = permits.filter(
    (row) =>
      Number(row.id) !== Number(permit.id) &&
      String(row.监护人) === String(permit.监护人) &&
      ['待检测', '已签发', '作业中'].includes(String(row.status)),
  )
  if (!rivals.length) {
    return ''
  }
  const names = rivals.map((row) => String(row.作业票编号)).join('、')
  const winner = rivals.reduce((acc, row) => higherPriority(acc, row), permit)
  const winLabel = Number(winner.id) === Number(permit.id) ? '本票' : `作业票${String(winner.作业票编号)}`
  const reason =
    String(winner.作业类型) === '受限空间'
      ? '受限空间内气体环境随时间变化、检测结论时效短且救援难度大，故受限空间优先于动火'
      : '同为动火作业，按申请先后（票号小者）优先'
  return `与${names}共用监护人${String(permit.监护人)}，裁决${winLabel}（${String(winner.作业类型)}）先行开工：${reason}。`
}

// —— 整票退回：缺原始记录的，票退回「申请」并记异常，补齐后重新走流程 ——
function bounce(rows: EntryRow[], index: number, reason: string): ActionResult {
  const row = rows[index]
  const code = String(row.作业票编号)
  const note = String(row.签发说明 ?? '')
  const next = [...rows]
  next[index] = {
    ...row,
    status: '申请',
    pending: true,
    abnormal: true,
    签发说明: `${note}${note ? ' ' : ''}【退回${now()}】${reason}`,
  }
  saveRows(PERMIT_KEY, next)
  return { ok: false, message: `整票退回「申请」：作业票${code}，${reason}` }
}

// —— 整改台账：签发、终结的结论落到安全巡检模块 ——
function ledgerOnIssue(permit: EntryRow, note: string): void {
  const code = String(permit.作业票编号)
  const rows = listRows(SAFETY_KEY)
  if (rows.some((row) => String(row.巡检编号) === `XC-${code}`)) {
    return
  }
  rows.push({
    id: nextId(rows),
    status: '待整改',
    pending: true,
    abnormal: false,
    巡检编号: `XC-${code}`,
    巡检区域: String(permit.作业地点),
    巡检项目: `${String(permit.作业类型)}作业许可签发`,
    发现问题: `作业票${code}已签发：${note}`,
    隐患等级: '一般',
    整改期限: String(permit.作业日期),
    巡检人员: '许可系统',
    巡检状态: '待整改',
  })
  saveRows(SAFETY_KEY, rows)
}

function ledgerOnTerminate(permit: EntryRow): void {
  const code = String(permit.作业票编号)
  const rows = listRows(SAFETY_KEY)
  const next = rows.map((row) =>
    String(row.巡检编号) === `XC-${code}`
      ? { ...row, status: '已闭环', pending: false, 巡检状态: '已闭环' }
      : row,
  )
  if (!next.some((row) => String(row.巡检编号) === `XC-${code}-结`)) {
    next.push({
      id: nextId(next),
      status: '已闭环',
      pending: false,
      abnormal: false,
      巡检编号: `XC-${code}-结`,
      巡检区域: String(permit.作业地点),
      巡检项目: `${String(permit.作业类型)}作业终结归档`,
      发现问题: `作业票${code}已终结归档，现场恢复确认，签发项闭环`,
      隐患等级: '一般',
      整改期限: String(permit.作业日期),
      巡检人员: '许可系统',
      巡检状态: '已闭环',
    })
  }
  saveRows(SAFETY_KEY, next)
}

// —— 查询：未终结数与列表的唯一取数口，作业许可页与安全巡检页都从这里读，不各算一遍 ——
export function listPermits(filters: Record<string, string> = {}): EntryRow[] {
  return filterRows(listRows(PERMIT_KEY), filters)
}

export function unterminatedPermits(): EntryRow[] {
  return listRows(PERMIT_KEY).filter((row) => String(row.status) !== '终结归档')
}

export function unterminatedPermitCount(): number {
  return unterminatedPermits().length
}

// —— 登记作业票：落「申请」 ——
export type PermitDraft = {
  作业类型: string
  作业地点: string
  作业内容: string
  作业日期: string
  监护人: string
  申请人: string
}

export function createPermit(draft: PermitDraft, requestId: string): ActionResult {
  return withTransaction(() => {
    const replay = replayIfSeen(requestId)
    if (replay) {
      return replay
    }
    const missing = Object.entries(draft).find(([, value]) => value.trim() === '')
    if (missing) {
      return { ok: false, message: '作业类型、作业地点、作业内容、作业日期、监护人、申请人都不能空着' }
    }
    if (!['动火', '受限空间'].includes(draft.作业类型)) {
      return { ok: false, message: `作业类型只认「动火」「受限空间」，收到的是「${draft.作业类型}」` }
    }
    const rows = listRows(PERMIT_KEY)
    const prefix = draft.作业类型 === '受限空间' ? 'SX' : 'DH'
    const code = nextCode(rows, '作业票编号', prefix)
    rows.push({
      id: nextId(rows),
      status: '申请',
      pending: true,
      abnormal: false,
      作业票编号: code,
      ...draft,
      签发说明: '',
      附件: '',
    })
    saveRows(PERMIT_KEY, rows)
    const message = `作业票${code}已登记，当前停在「申请」，下一步「送检」`
    recordOp(requestId, true, message)
    return { ok: true, message }
  })
}

// —— 状态流转：送检、签发、开工、终结 ——
export function advancePermit(id: number, action: string, requestId: string): ActionResult {
  return withTransaction(() => {
    const replay = replayIfSeen(requestId)
    if (replay) {
      return replay
    }
    const rows = listRows(PERMIT_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的作业票` }
    }
    const row = rows[index]
    const code = String(row.作业票编号)
    const status = String(row.status)

    if (status === '终结归档') {
      return { ok: false, message: `驳回：作业票${code}已终结归档，只能补附件，回不到「作业中」` }
    }
    const step = NEXT_STEP[status]
    if (action !== step.action) {
      // 同一张票重复提交签发只生效一次
      if (action === '签发' && PERMIT_STATUSES.indexOf(status) > PERMIT_STATUSES.indexOf('待检测')) {
        return { ok: true, message: `作业票${code}已签发过，重复提交签发只生效一次，本次忽略` }
      }
      return {
        ok: false,
        message: `驳回：作业票${code}当前停在「${status}」，下一步只能「${step.action}」，不能执行「${action}」`,
      }
    }

    if (action === '签发') {
      const gas = gasConclusionOf(code)
      if (gas.state === 'none') {
        const result = bounce(rows, index, '缺少气体检测原始记录，检测结果必须从原始记录取')
        recordOp(requestId, false, result.message)
        return result
      }
      if (gas.state === 'pending') {
        const result = bounce(rows, index, `气体检测还没出结论（原始记录${gas.ref}结论为空），检测没出结论不许签发`)
        recordOp(requestId, false, result.message)
        return result
      }
      if (gas.conclusion !== '合格') {
        const result = bounce(rows, index, `检测结论为「${gas.conclusion}」（${gas.ref}），不合格不许签发`)
        recordOp(requestId, false, result.message)
        return result
      }
    }

    if (action === '开工') {
      const guardian = String(row.监护人)
      if (!guardianSigned(code, guardian)) {
        const result = bounce(rows, index, `监护人${guardian}没有签到原始记录，监护人没签到不许进「作业中」`)
        recordOp(requestId, false, result.message)
        return result
      }
      const others = rows.filter(
        (item) => Number(item.id) !== id && String(item.监护人) === guardian,
      )
      const busy = others.find((item) => String(item.status) === '作业中')
      if (busy) {
        return {
          ok: false,
          message: `驳回：监护人${guardian}正在监护作业票${String(busy.作业票编号)}，一名监护人同时只能监护一处作业`,
        }
      }
      const waiting = others.filter((item) => String(item.status) === '已签发')
      const first = waiting.reduce((acc, item) => higherPriority(acc, item), row)
      if (Number(first.id) !== id) {
        return {
          ok: false,
          message: `驳回：按签发裁决，作业票${String(first.作业票编号)}（${String(first.作业类型)}）优先开工，本票暂缓`,
        }
      }
    }

    const note =
      action === '签发'
        ? `${now()} 签发人：值班管理员。${arbitrationNote(row, rows)}`
        : String(row.签发说明 ?? '')
    const next = [...rows]
    next[index] = {
      ...row,
      status: step.target,
      pending: step.target !== '终结归档',
      abnormal: false,
      签发说明: note,
    }
    saveRows(PERMIT_KEY, next)
    if (action === '签发') {
      ledgerOnIssue(next[index], note)
    }
    if (action === '终结') {
      ledgerOnTerminate(next[index])
    }
    const message = `作业票${code}已${action}，当前状态「${step.target}」`
    recordOp(requestId, true, message)
    return { ok: true, message }
  })
}

// —— 补附件：已终结的票唯一还能做的操作 ——
export function appendAttachment(id: number, name: string, requestId: string): ActionResult {
  return withTransaction(() => {
    const replay = replayIfSeen(requestId)
    if (replay) {
      return replay
    }
    if (!name.trim()) {
      return { ok: false, message: '附件名称不能空着' }
    }
    const rows = listRows(PERMIT_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的作业票` }
    }
    const row = rows[index]
    const files = String(row.附件 ?? '').trim()
    const next = [...rows]
    next[index] = { ...row, 附件: files ? `${files}、${name.trim()}` : name.trim() }
    saveRows(PERMIT_KEY, next)
    const message = `作业票${String(row.作业票编号)}已补登附件：${name.trim()}`
    recordOp(requestId, true, message)
    return { ok: true, message }
  })
}

// —— 气体检测原始记录：结论为空表示还没出结论；存量补录的占位记录在补结论时原地补齐 ——
export function recordGasCheck(
  code: string,
  conclusion: string,
  detector: string,
  requestId: string,
): ActionResult {
  return withTransaction(() => {
    const replay = replayIfSeen(requestId)
    if (replay) {
      return replay
    }
    const permit = listRows(PERMIT_KEY).find((row) => String(row.作业票编号) === code)
    if (!permit) {
      return { ok: false, message: `没有找到作业票${code}，检测记录必须挂在票上` }
    }
    if (!detector.trim()) {
      return { ok: false, message: '检测人不能空着' }
    }
    const rows = listRows(GASCHECK_KEY)
    const placeholder = rows.find(
      (row) =>
        String(row.作业票编号) === code &&
        String(row.来源) === '存量补录' &&
        String(row.检测结论 ?? '').trim() === '',
    )
    if (placeholder) {
      const index = rows.findIndex((row) => Number(row.id) === Number(placeholder.id))
      const next = [...rows]
      next[index] = {
        ...rows[index],
        检测结论: conclusion,
        检测人: detector.trim(),
        检测时间: now(),
      }
      saveRows(GASCHECK_KEY, next)
      const message = `作业票${code}的存量补录占位记录${String(placeholder.检测编号)}已补录结论「${conclusion || '空'}」`
      recordOp(requestId, true, message)
      return { ok: true, message }
    }
    const ref = nextCode(rows, '检测编号', 'JC')
    rows.push({
      id: nextId(rows),
      status: '已记录',
      pending: false,
      abnormal: false,
      检测编号: ref,
      作业票编号: code,
      检测结论: conclusion,
      检测人: detector.trim(),
      检测时间: now(),
      来源: '现场检测',
    })
    saveRows(GASCHECK_KEY, rows)
    const message = `作业票${code}的气体检测原始记录${ref}已登记，结论「${conclusion || '未出'}」`
    recordOp(requestId, true, message)
    return { ok: true, message }
  })
}

// —— 监护人签到原始记录：签到人必须就是票面监护人 ——
export function recordGuardianSignIn(
  code: string,
  guardian: string,
  requestId: string,
): ActionResult {
  return withTransaction(() => {
    const replay = replayIfSeen(requestId)
    if (replay) {
      return replay
    }
    const permit = listRows(PERMIT_KEY).find((row) => String(row.作业票编号) === code)
    if (!permit) {
      return { ok: false, message: `没有找到作业票${code}，签到必须挂在票上` }
    }
    if (String(permit.监护人) !== guardian.trim()) {
      return {
        ok: false,
        message: `驳回：作业票${code}票面监护人是${String(permit.监护人)}，${guardian.trim() || '空'}签到不算数`,
      }
    }
    const rows = listRows(GUARDIAN_KEY)
    if (
      rows.some((row) => String(row.作业票编号) === code && String(row.监护人) === guardian.trim())
    ) {
      return { ok: true, message: `作业票${code}监护人${guardian.trim()}已签到过，重复签到忽略` }
    }
    const ref = nextCode(rows, '签到编号', 'QD')
    rows.push({
      id: nextId(rows),
      status: '已签到',
      pending: false,
      abnormal: false,
      签到编号: ref,
      作业票编号: code,
      监护人: guardian.trim(),
      签到时间: now(),
    })
    saveRows(GUARDIAN_KEY, rows)
    const message = `作业票${code}监护人${guardian.trim()}已签到（${ref}）`
    recordOp(requestId, true, message)
    return { ok: true, message }
  })
}

// —— 存量纸质票迁移：按作业日期回填 ——
// 回填规则：
// 1. 作业日期已过、检测与签到齐全 → 落「终结归档」；
// 2. 作业日期已过、缺检测或签到 → 落「待检测」并记异常，补齐原始记录后重走流程；
// 3. 作业日期未到 → 落「待检测」，检测齐的可直接签发；
// 4. 缺检测记录的一律生成来源标注「存量补录」的占位检测记录，结论留空——占位不算结论，
//    必须检测人补录结论（原地补齐，不另起一条）后才允许签发。
type LegacyPermit = {
  作业票编号: string
  作业类型: string
  作业地点: string
  作业内容: string
  作业日期: string
  监护人: string
  申请人: string
  检测结论: string
  已签到: boolean
}

const LEGACY_PERMITS: LegacyPermit[] = [
  { 作业票编号: 'ZY-260901', 作业类型: '动火', 作业地点: '掘进面1号仓', 作业内容: '轨道焊接', 作业日期: '2026-09-28', 监护人: '王安全', 申请人: '张申请', 检测结论: '合格', 已签到: true },
  { 作业票编号: 'ZY-260902', 作业类型: '受限空间', 作业地点: '掘进面人闸舱', 作业内容: '舱内检修', 作业日期: '2026-09-30', 监护人: '李监护', 申请人: '李申请', 检测结论: '', 已签到: false },
  { 作业票编号: 'ZY-261001', 作业类型: '动火', 作业地点: '掘进面2号仓', 作业内容: '支架焊接', 作业日期: '2026-10-08', 监护人: '赵值守', 申请人: '钱申请', 检测结论: '合格', 已签到: false },
  { 作业票编号: 'ZY-261002', 作业类型: '受限空间', 作业地点: '掘进面泥水舱', 作业内容: '舱底检查', 作业日期: '2026-10-09', 监护人: '王安全', 申请人: '赵申请', 检测结论: '', 已签到: false },
]

export function migrateLegacyPermits(requestId: string): ActionResult {
  return withTransaction(() => {
    const replay = replayIfSeen(requestId)
    if (replay) {
      return replay
    }
    const permits = listRows(PERMIT_KEY)
    const gasRows = listRows(GASCHECK_KEY)
    const guardianRows = listRows(GUARDIAN_KEY)
    const currentDay = today()
    let migrated = 0
    let skipped = 0
    let abnormalCount = 0
    for (const legacy of LEGACY_PERMITS) {
      if (permits.some((row) => String(row.作业票编号) === legacy.作业票编号)) {
        skipped += 1
        continue
      }
      const past = legacy.作业日期 < currentDay
      const hasGas = legacy.检测结论.trim() !== ''
      gasRows.push({
        id: nextId(gasRows),
        status: '已记录',
        pending: false,
        abnormal: false,
        检测编号: nextCode(gasRows, '检测编号', 'JC'),
        作业票编号: legacy.作业票编号,
        检测结论: legacy.检测结论,
        检测人: hasGas ? '存量检测员' : '',
        检测时间: `${legacy.作业日期} 08:00`,
        来源: '存量补录',
      })
      if (legacy.已签到) {
        guardianRows.push({
          id: nextId(guardianRows),
          status: '已签到',
          pending: false,
          abnormal: false,
          签到编号: nextCode(guardianRows, '签到编号', 'QD'),
          作业票编号: legacy.作业票编号,
          监护人: legacy.监护人,
          签到时间: `${legacy.作业日期} 08:30`,
        })
      }
      let status = '待检测'
      let pending = true
      let abnormal = false
      let note: string
      if (past && hasGas && legacy.已签到) {
        status = '终结归档'
        pending = false
        note = '存量迁移：纸质票按作业日期回填，检测与签到齐全、作业日期已过，按终结归档落位。'
      } else if (past) {
        abnormal = true
        abnormalCount += 1
        const missing = hasGas ? '缺监护人签到记录' : '缺气体检测记录'
        note = `存量迁移：纸质票按作业日期回填，${missing}，落到「待检测」并记异常，补齐原始记录后方可签发。`
      } else {
        note = hasGas
          ? '存量迁移：纸质票按作业日期回填，检测结论已随票补录，落到「待检测」，可签发。'
          : '存量迁移：纸质票按作业日期回填，缺气体检测记录，已生成「存量补录」占位记录，落到「待检测」，须补录结论后签发。'
      }
      permits.push({
        id: nextId(permits),
        status,
        pending,
        abnormal,
        作业票编号: legacy.作业票编号,
        作业类型: legacy.作业类型,
        作业地点: legacy.作业地点,
        作业内容: legacy.作业内容,
        作业日期: legacy.作业日期,
        监护人: legacy.监护人,
        申请人: legacy.申请人,
        签发说明: note,
        附件: '',
      })
      migrated += 1
    }
    saveRows(PERMIT_KEY, permits)
    saveRows(GASCHECK_KEY, gasRows)
    saveRows(GUARDIAN_KEY, guardianRows)
    const message = `存量迁移完成：新回填${migrated}张（其中记异常${abnormalCount}张），已存在跳过${skipped}张`
    recordOp(requestId, true, message)
    return { ok: true, message }
  })
}
