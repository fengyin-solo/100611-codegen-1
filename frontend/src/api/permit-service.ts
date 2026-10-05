import { listRows, saveBatch } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 动火与受限空间作业许可：状态机与守卫全部收在这里，页面不做业务判断。
//
// 裁决口径（冲突时以谁为准）：
// 1. 气体检测结论、监护人签到一律以「原始记录」集合为准，票面上的手填值不作数；
// 2. 一名监护人同一时刻只能监护一张未终结的票；动火与受限空间共用一名监护人时
//    受限空间优先开工——受限空间内气体环境变化快、人员被困与救援难度大，监护人
//    必须全程在入口值守不得分身，动火作业的火源管控可延后到受限空间终结后再执行。

const PERMIT_KEY = 'permit'
const GAS_KEY = 'gasTest'
const GUARDIAN_KEY = 'guardian'
const LEDGER_KEY = 'rectification'
const META_KEY = 'permitMeta'

export const PERMIT_STAGES = ['申请', '待检测', '已签发', '作业中', '终结归档'] as const

// 动作 → 允许的发起段与目标段，只能顺着走，不许跳级
const ACTION_FLOW: Record<string, { from: string; to: string }> = {
  送检: { from: '申请', to: '待检测' },
  签发: { from: '待检测', to: '已签发' },
  开工: { from: '已签发', to: '作业中' },
  终结: { from: '作业中', to: '终结归档' },
}

// 每段唯一允许的下一步动作，驳回时用来指出停在哪一段
const NEXT_ACTION: Record<string, string> = {
  申请: '送检',
  待检测: '签发',
  已签发: '开工',
  作业中: '终结',
}

const RULING_REASON =
  '受限空间内气体环境变化快、被困与救援难度大，监护人须全程在入口值守不得分身；动火作业的火源管控可延后，待受限空间作业终结后重新签发'

const MIGRATION_RULE =
  '存量票按作业日期升序回填并重新编号；已到「已签发」及以后的票缺气体检测记录时，取作业日期当天洞内通风机组运行中且有害气体浓度未超限的记录补录为合格（标注迁移补录），当天无合格通风记录可依据的整票退回「待检测」并标异常；「作业中」的票缺签到记录按票面监护人补录签到'

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '')
}

function stageIndex(status: string): number {
  return PERMIT_STAGES.indexOf(status as (typeof PERMIT_STAGES)[number])
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function now(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function appendNote(existing: string, note: string): string {
  return existing ? `${existing}；${note}` : note
}

// 有害气体浓度「超限」才算超限；「未超限」包含子串"超限"，要先排除
function isOverLimit(level: string): boolean {
  return level.includes('超限') && !level.includes('未超限')
}

function ledgerRow(ticketNo: string, stage: string, conclusion: string, flagged: boolean): EntryRow {
  return {
    id: -1, // 由调用方按现有台账重编
    status: flagged ? '待跟进' : '已记录',
    pending: flagged,
    abnormal: flagged,
    来源票号: ticketNo,
    环节: stage,
    结论: conclusion,
    登记时间: now(),
  }
}

// ---------- 存量迁移：只跑一次 ----------

function ensureMigrated(): void {
  const meta = listRows(META_KEY)
  if (meta.some((row) => text(row, '迁移完成') === '是')) {
    return
  }
  const legacy = listRows(PERMIT_KEY)
  const gasTests = listRows(GAS_KEY).map((row) => ({ ...row }))
  const guardians = listRows(GUARDIAN_KEY).map((row) => ({ ...row }))
  const ledger = listRows(LEDGER_KEY).map((row) => ({ ...row }))
  const ventilation = listRows('ventilation')
  let backfilledGas = 0
  let backfilledGuardian = 0
  let returned = 0

  // 按作业日期升序、同日按票号排序回填，重新编连续 id
  const migrated = [...legacy]
    .sort((a, b) => {
      const byDate = text(a, '作业日期').localeCompare(text(b, '作业日期'))
      return byDate !== 0 ? byDate : text(a, '票号').localeCompare(text(b, '票号'))
    })
    .map((row, index): EntryRow => ({ ...row, id: index + 1 }))

  for (const row of migrated) {
    const ticketNo = text(row, '票号')
    if (stageIndex(text(row, 'status')) >= stageIndex('已签发')) {
      if (!gasTests.some((item) => text(item, '票号') === ticketNo)) {
        const vent = ventilation.find(
          (item) =>
            text(item, '检测日期') === text(row, '作业日期') &&
            (text(item, 'status') === '运行中' || text(item, '运行状态') === '运行中') &&
            !isOverLimit(text(item, '有害气体浓度')),
        )
        if (vent) {
          gasTests.push({
            id: nextId(gasTests),
            status: '已记录',
            pending: false,
            abnormal: false,
            票号: ticketNo,
            检测时间: `${text(row, '作业日期')} 08:00`,
            检测人: text(vent, '值守人员') || '迁移补录',
            氧气: '20.8%',
            可燃气: '0%LEL',
            有毒气体: '未检出',
            检测结论: '合格',
            备注: `迁移补录：依据当日洞内通风运行记录（${text(vent, '机组编号')}）`,
          })
          backfilledGas += 1
          row['签发说明'] = appendNote(
            text(row, '签发说明'),
            '存量迁移：气体检测记录缺失，已按当日通风运行记录补录',
          )
        } else {
          row.status = '待检测'
          row.pending = true
          row.abnormal = true
          row['签发说明'] = appendNote(
            text(row, '签发说明'),
            '存量迁移：缺气体检测原始记录且当日无合格通风记录可依据，整票退回「待检测」补检',
          )
          returned += 1
        }
      }
      if (stageIndex(text(row, 'status')) >= stageIndex('已签发') && !text(row, '签发批次')) {
        row['签发批次'] = `ISS-LEGACY-${ticketNo}`
      }
    }
    if (text(row, 'status') === '作业中' && !guardians.some((item) => text(item, '票号') === ticketNo)) {
      guardians.push({
        id: nextId(guardians),
        status: '已签到',
        pending: false,
        abnormal: false,
        票号: ticketNo,
        监护人: text(row, '监护人'),
        签到时间: `${text(row, '作业日期')} 08:30`,
        备注: '迁移补录：按票面监护人回填签到',
      })
      backfilledGuardian += 1
    }
  }

  const report = `存量迁移：按作业日期回填 ${migrated.length} 张，补录检测 ${backfilledGas} 条、签到 ${backfilledGuardian} 条，缺检测退回 ${returned} 张`
  ledger.push({ ...ledgerRow('—', '存量迁移', report, returned > 0), id: nextId(ledger) })

  saveBatch({
    [PERMIT_KEY]: migrated,
    [GAS_KEY]: gasTests,
    [GUARDIAN_KEY]: guardians,
    [LEDGER_KEY]: ledger,
    [META_KEY]: [
      {
        id: 1,
        status: '已迁移',
        pending: false,
        abnormal: false,
        迁移完成: '是',
        迁移时间: now(),
        迁移票数: migrated.length,
        补录检测数: backfilledGas,
        补录签到数: backfilledGuardian,
        退回票数: returned,
        规则说明: MIGRATION_RULE,
      },
    ],
  })
}

// ---------- 只读口径：两个入口共用，不各算一遍 ----------

export function listPermits(filters: Record<string, string> = {}): EntryRow[] {
  ensureMigrated()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const rows = listRows(PERMIT_KEY)
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => text(row, field).includes(value.trim())),
  )
}

export function listGasTests(): EntryRow[] {
  ensureMigrated()
  return listRows(GAS_KEY)
}

export function listGuardianCheckins(): EntryRow[] {
  ensureMigrated()
  return listRows(GUARDIAN_KEY)
}

export function listRectifications(): EntryRow[] {
  ensureMigrated()
  return listRows(LEDGER_KEY)
}

// 未终结作业数：全站唯一口径，作业许可页与安全巡检页都读这里
export function countOpenPermits(): number {
  ensureMigrated()
  return listRows(PERMIT_KEY).filter((row) => text(row, 'status') !== '终结归档').length
}

export function permitStats(): { label: string; value: number }[] {
  ensureMigrated()
  const rows = listRows(PERMIT_KEY)
  const count = (status: string) => rows.filter((row) => text(row, 'status') === status).length
  return [
    { label: '未终结作业数', value: countOpenPermits() },
    { label: '待签发', value: count('待检测') },
    { label: '作业中', value: count('作业中') },
    { label: '已归档', value: count('终结归档') },
  ]
}

export function migrationReport(): EntryRow | undefined {
  ensureMigrated()
  return listRows(META_KEY).find((row) => text(row, '迁移完成') === '是')
}

// ---------- 登记与原始记录 ----------

export function createPermit(input: {
  作业类型: string
  作业地点: string
  作业日期: string
  申请人: string
  监护人: string
}): ActionResult {
  ensureMigrated()
  const missing = Object.entries(input).find(([, value]) => value.trim() === '')
  if (missing) {
    return { ok: false, message: `登记作业票缺项：${missing[0]} 不能为空` }
  }
  if (!['动火', '受限空间'].includes(input.作业类型)) {
    return { ok: false, message: '作业类型只能是「动火」或「受限空间」' }
  }
  const permits = listRows(PERMIT_KEY)
  const prefix = input.作业类型 === '动火' ? 'DH' : 'SX'
  const [year, month, day] = input.作业日期.split('-')
  const datePrefix = `${prefix}-${year}-${month}${day}`
  const seq = permits.filter((row) => text(row, '票号').startsWith(datePrefix)).length + 1
  const ticketNo = `${datePrefix}-${String(seq).padStart(2, '0')}`
  const row: EntryRow = {
    id: nextId(permits),
    status: '申请',
    pending: true,
    abnormal: false,
    票号: ticketNo,
    ...input,
    签发说明: '',
    签发批次: '',
    附件: '',
    申请时间: now(),
    签发时间: '',
    开工时间: '',
    终结时间: '',
  }
  try {
    saveBatch({ [PERMIT_KEY]: [...permits, row] })
  } catch {
    return { ok: false, message: '落库失败，本次登记已整套撤回' }
  }
  return { ok: true, message: `作业票 ${ticketNo} 已登记，当前停在「申请」，请依次送检、签发` }
}

export function recordGasTest(input: {
  票号: string
  检测人: string
  氧气: string
  可燃气: string
  有毒气体: string
  检测结论: string
}): ActionResult {
  ensureMigrated()
  if (!listRows(PERMIT_KEY).some((row) => text(row, '票号') === input.票号)) {
    return { ok: false, message: `没有找到票号为 ${input.票号} 的作业票` }
  }
  if (!['合格', '不合格'].includes(input.检测结论)) {
    return { ok: false, message: '检测结论只能是「合格」或「不合格」' }
  }
  const gasTests = listRows(GAS_KEY)
  const row: EntryRow = {
    id: nextId(gasTests),
    status: '已记录',
    pending: false,
    abnormal: input.检测结论 !== '合格',
    ...input,
    检测时间: now(),
    备注: '',
  }
  try {
    saveBatch({ [GAS_KEY]: [...gasTests, row] })
  } catch {
    return { ok: false, message: '落库失败，本次检测记录已整套撤回' }
  }
  return { ok: true, message: `票 ${input.票号} 的气体检测已录入原始记录（结论「${input.检测结论}」）` }
}

export function recordGuardianCheckin(input: { 票号: string; 监护人: string }): ActionResult {
  ensureMigrated()
  const ticket = listRows(PERMIT_KEY).find((row) => text(row, '票号') === input.票号)
  if (!ticket) {
    return { ok: false, message: `没有找到票号为 ${input.票号} 的作业票` }
  }
  if (text(ticket, '监护人') !== input.监护人) {
    return {
      ok: false,
      message: `签到驳回：票 ${input.票号} 票面监护人是 ${text(ticket, '监护人')}，签到记录以票面为准，${input.监护人} 不能代签`,
    }
  }
  const guardians = listRows(GUARDIAN_KEY)
  const row: EntryRow = {
    id: nextId(guardians),
    status: '已签到',
    pending: false,
    abnormal: false,
    ...input,
    签到时间: now(),
    备注: '',
  }
  try {
    saveBatch({ [GUARDIAN_KEY]: [...guardians, row] })
  } catch {
    return { ok: false, message: '落库失败，本次签到已整套撤回' }
  }
  return { ok: true, message: `监护人 ${input.监护人} 已为票 ${input.票号} 签到` }
}

// ---------- 状态机 ----------

// 整票退回：回到「申请」段、标异常，结论落整改台账
function bounce(
  permits: EntryRow[],
  index: number,
  reason: string,
): ActionResult {
  const ticket = permits[index]
  const ticketNo = text(ticket, '票号')
  const updated: EntryRow = {
    ...ticket,
    status: '申请',
    pending: true,
    abnormal: true,
    签发说明: appendNote(text(ticket, '签发说明'), reason),
  }
  const nextPermits = [...permits]
  nextPermits[index] = updated
  const ledger = listRows(LEDGER_KEY)
  const nextLedger = [...ledger, { ...ledgerRow(ticketNo, '退回', reason, true), id: nextId(ledger) }]
  try {
    saveBatch({ [PERMIT_KEY]: nextPermits, [LEDGER_KEY]: nextLedger })
  } catch {
    return { ok: false, message: '落库失败，本次退回已整套撤回' }
  }
  return { ok: false, message: `整票退回：${reason}，票 ${ticketNo} 退回「申请」段重新走流程` }
}

export function runPermitAction(id: number, action: string): ActionResult {
  ensureMigrated()
  const flow = ACTION_FLOW[action]
  if (!flow) {
    return { ok: false, message: `作业票没有登记「${action}」这个动作` }
  }
  const permits = listRows(PERMIT_KEY).map((row) => ({ ...row }))
  const index = permits.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的作业票` }
  }
  const ticket = permits[index]
  const ticketNo = text(ticket, '票号')
  const current = text(ticket, 'status')

  if (current === '终结归档') {
    return { ok: false, message: `驳回：票 ${ticketNo} 已终结归档，只能补附件，回不到「作业中」` }
  }
  // 幂等：同一张票重复提交签发只生效一次，不重复落账
  if (action === '签发' && stageIndex(current) >= stageIndex('已签发')) {
    return {
      ok: true,
      message: `票 ${ticketNo} 已签发（批次 ${text(ticket, '签发批次')}），重复提交只生效一次`,
    }
  }
  if (current !== flow.from) {
    return {
      ok: false,
      message: `驳回：票 ${ticketNo} 当前停在「${current}」，「${action}」只能从「${flow.from}」发起；请先执行「${NEXT_ACTION[current]}」按序流转`,
    }
  }

  const ledger = listRows(LEDGER_KEY)

  if (action === '签发') {
    // 气体检测结论以原始记录为准：缺记录或结论不合格都整票退回
    const test = [...listRows(GAS_KEY)].reverse().find((row) => text(row, '票号') === ticketNo)
    if (!test) {
      return bounce(permits, index, '签发驳回：缺气体检测原始记录，检测没出结论不许签发')
    }
    if (text(test, '检测结论') !== '合格') {
      return bounce(permits, index, `签发驳回：最新气体检测结论为「${text(test, '检测结论')}」`)
    }
    // 监护人冲突裁决：一名监护人同一时刻只能监护一张未终结的票
    const conflict = permits.find(
      (row) =>
        Number(row.id) !== id &&
        text(row, '监护人') === text(ticket, '监护人') &&
        ['已签发', '作业中'].includes(text(row, 'status')),
    )
    let ruling = ''
    if (conflict) {
      const conflictNo = text(conflict, '票号')
      const conflictType = text(conflict, '作业类型')
      const conflictStatus = text(conflict, 'status')
      if (conflictStatus === '已签发' && conflictType === '动火' && text(ticket, '作业类型') === '受限空间') {
        // 受限空间优先：把尚未开工的动火票挤回待检测
        const conflictIndex = permits.findIndex((row) => Number(row.id) === Number(conflict.id))
        permits[conflictIndex] = {
          ...permits[conflictIndex],
          status: '待检测',
          pending: true,
          签发说明: appendNote(
            text(permits[conflictIndex], '签发说明'),
            `裁决：与票 ${ticketNo} 共用监护人 ${text(ticket, '监护人')}，受限空间作业优先，本票退回「待检测」，待其终结后重新签发`,
          ),
        }
        ruling = `裁决：与票 ${conflictNo}（动火）共用监护人 ${text(ticket, '监护人')}，受限空间优先开工——${RULING_REASON}`
      } else {
        return {
          ok: false,
          message: `驳回：监护人 ${text(ticket, '监护人')} 正监护票 ${conflictNo}（${conflictType}，${conflictStatus}），一名监护人同一时刻只能监护一张票；本票停在「待检测」`,
        }
      }
    }
    const batch = `ISS-${ticketNo}-${Date.now().toString(36)}`
    const conclusion = `同意签发。气体检测 ${text(test, '检测时间')} 结论「合格」（${text(test, '检测人')}）。${ruling}`
    permits[index] = {
      ...ticket,
      status: '已签发',
      pending: true,
      abnormal: false,
      签发说明: appendNote(text(ticket, '签发说明'), conclusion),
      签发批次: batch,
      签发时间: now(),
    }
    const nextLedger = [...ledger, { ...ledgerRow(ticketNo, '签发', conclusion, false), id: nextId(ledger) }]
    try {
      saveBatch({ [PERMIT_KEY]: permits, [LEDGER_KEY]: nextLedger })
    } catch {
      return { ok: false, message: '落库失败，本次签发已整套撤回' }
    }
    return { ok: true, message: `票 ${ticketNo} 已签发（批次 ${batch}），结论已落整改台账` }
  }

  if (action === '开工') {
    // 监护人签到以原始记录为准：缺签到整票退回
    if (!listRows(GUARDIAN_KEY).some((row) => text(row, '票号') === ticketNo)) {
      return bounce(permits, index, '开工驳回：缺监护人签到原始记录，监护人没签到不许进洞作业')
    }
    const busy = permits.find(
      (row) =>
        Number(row.id) !== id &&
        text(row, '监护人') === text(ticket, '监护人') &&
        text(row, 'status') === '作业中',
    )
    if (busy) {
      return {
        ok: false,
        message: `驳回：监护人 ${text(ticket, '监护人')} 正在监护票 ${text(busy, '票号')} 作业中，不能分身；本票停在「已签发」`,
      }
    }
    permits[index] = { ...ticket, status: '作业中', pending: true, abnormal: false, 开工时间: now() }
    try {
      saveBatch({ [PERMIT_KEY]: permits })
    } catch {
      return { ok: false, message: '落库失败，本次开工已整套撤回' }
    }
    return { ok: true, message: `票 ${ticketNo} 已开工，监护人 ${text(ticket, '监护人')} 在场监护` }
  }

  if (action === '送检') {
    permits[index] = { ...ticket, status: '待检测', pending: true, abnormal: false }
    try {
      saveBatch({ [PERMIT_KEY]: permits })
    } catch {
      return { ok: false, message: '落库失败，本次送检已整套撤回' }
    }
    return { ok: true, message: `票 ${ticketNo} 已送检，当前停在「待检测」，等检测结论` }
  }

  // 终结
  const conclusion = '作业终结，现场清理与人员撤离确认完毕，归档'
  permits[index] = {
    ...ticket,
    status: '终结归档',
    pending: false,
    abnormal: false,
    终结时间: now(),
  }
  const nextLedger = [...ledger, { ...ledgerRow(ticketNo, '终结', conclusion, false), id: nextId(ledger) }]
  try {
    saveBatch({ [PERMIT_KEY]: permits, [LEDGER_KEY]: nextLedger })
  } catch {
    return { ok: false, message: '落库失败，本次终结已整套撤回' }
  }
  return { ok: true, message: `票 ${ticketNo} 已终结归档，结论已落整改台账；此后只能补附件` }
}

// 已终结的票唯一还允许的操作：补附件
export function appendAttachment(id: number, name: string): ActionResult {
  ensureMigrated()
  const permits = listRows(PERMIT_KEY).map((row) => ({ ...row }))
  const index = permits.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的作业票` }
  }
  const ticket = permits[index]
  if (text(ticket, 'status') !== '终结归档') {
    return {
      ok: false,
      message: `驳回：票 ${text(ticket, '票号')} 停在「${text(ticket, 'status')}」，只有已终结归档的票才能补附件`,
    }
  }
  if (name.trim() === '') {
    return { ok: false, message: '附件名称不能为空' }
  }
  permits[index] = {
    ...ticket,
    附件: appendNote(text(ticket, '附件'), `${name.trim()}（${now()}补录）`),
  }
  try {
    saveBatch({ [PERMIT_KEY]: permits })
  } catch {
    return { ok: false, message: '落库失败，本次补附件已整套撤回' }
  }
  return { ok: true, message: `票 ${text(ticket, '票号')} 已补录附件「${name.trim()}」，状态保持终结归档` }
}
