// 冒烟测试：直接调 permit-service 验证状态机、守卫、裁决、幂等、迁移。
// 运行：npx esbuild test-permit.ts --bundle --format=esm --outfile=/tmp/test-permit.mjs --alias:@=./src && node /tmp/test-permit.mjs
import {
  appendAttachment,
  countOpenPermits,
  createPermit,
  listGasTests,
  listGuardianCheckins,
  listPermits,
  listRectifications,
  migrationReport,
  recordGasTest,
  recordGuardianCheckin,
  runPermitAction,
} from './src/api/permit-service'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name} ${detail}`)
  }
}

// ---- 迁移 ----
const meta = migrationReport()
check('迁移只跑一次且有报告', meta?.['迁移完成'] === '是')
check('迁移回填 7 张票', Number(meta?.['迁移票数']) === 7)
check('补录检测 1 条', Number(meta?.['补录检测数']) === 1)
check('补录签到 1 条', Number(meta?.['补录签到数']) === 1)
check('缺检测退回 1 张', Number(meta?.['退回票数']) === 1)

const permits = listPermits()
const byNo = (no: string) => permits.find((p) => p['票号'] === no)!
check('按作业日期回填重编号', Number(byNo('DH-2026-0915-01').id) === 1 && Number(byNo('DH-2026-1005-01').id) === 7)
check('通风记录补录检测的票保持终结归档', byNo('SX-2026-0916-01').status === '终结归档')
check('无依据的票退回待检测并标异常', byNo('DH-2026-0920-01').status === '待检测' && byNo('DH-2026-0920-01').abnormal === true)
check('补录的检测记录标注迁移补录', listGasTests().some((g) => g['票号'] === 'SX-2026-0916-01' && String(g['备注']).includes('迁移补录')))
check('作业中票补录签到', listGuardianCheckins().some((g) => g['票号'] === 'SX-2026-0922-01'))
check('迁移结论落整改台账', listRectifications().some((l) => l['环节'] === '存量迁移'))

// ---- 跳级驳回 ----
const fresh = createPermit({ 作业类型: '动火', 作业地点: '测试区', 作业日期: '2026-10-05', 申请人: '测试员', 监护人: '赵监护' })
check('登记成功停在申请', fresh.ok)
const freshNo = fresh.message.match(/DH-2026-1005-\d+/)![0]
const freshId = Number(listPermits().find((p) => p['票号'] === freshNo)!.id)
const skip = runPermitAction(freshId, '开工')
check('跳级驳回并指出停在哪一段', !skip.ok && skip.message.includes('停在「申请」'), skip.message)

// ---- 缺检测不许签发，整票退回 ----
runPermitAction(freshId, '送检')
const noGas = runPermitAction(freshId, '签发')
check('缺检测记录整票退回申请', !noGas.ok && noGas.message.includes('整票退回'))
check('退回后状态回到申请且异常', listPermits().find((p) => p['票号'] === freshNo)!.status === '申请')

// ---- 检测不合格也不许签发 ----
runPermitAction(freshId, '送检')
recordGasTest({ 票号: freshNo, 检测人: '孙检测', 氧气: '19.0%', 可燃气: '5%LEL', 有毒气体: '检出', 检测结论: '不合格' })
const badGas = runPermitAction(freshId, '签发')
check('检测不合格整票退回', !badGas.ok && badGas.message.includes('不合格'))

// ---- 合格检测 → 签发 → 幂等 → 开工守卫 → 终结 → 归档只补附件 ----
recordGasTest({ 票号: freshNo, 检测人: '孙检测', 氧气: '20.8%', 可燃气: '0%LEL', 有毒气体: '未检出', 检测结论: '合格' })
runPermitAction(freshId, '送检')
const issue = runPermitAction(freshId, '签发')
check('检测合格签发成功', issue.ok, issue.message)
const ledgerAfterIssue = listRectifications().filter((l) => l['来源票号'] === freshNo && l['环节'] === '签发').length
const dup = runPermitAction(freshId, '签发')
check('重复签发只生效一次', dup.ok && dup.message.includes('只生效一次'))
const ledgerAfterDup = listRectifications().filter((l) => l['来源票号'] === freshNo && l['环节'] === '签发').length
check('重复签发不重复落台账', ledgerAfterIssue === 1 && ledgerAfterDup === 1)

const noCheckin = runPermitAction(freshId, '开工')
check('缺签到整票退回', !noCheckin.ok && noCheckin.message.includes('签到'))
runPermitAction(freshId, '送检')
runPermitAction(freshId, '签发')
const wrongGuardian = recordGuardianCheckin({ 票号: freshNo, 监护人: '李监护' })
check('签到人须与票面监护人一致', !wrongGuardian.ok)
recordGuardianCheckin({ 票号: freshNo, 监护人: '赵监护' })
const start = runPermitAction(freshId, '开工')
check('签到后开工成功', start.ok, start.message)
const finish = runPermitAction(freshId, '终结')
check('终结成功并落台账', finish.ok && listRectifications().some((l) => l['来源票号'] === freshNo && l['环节'] === '终结'))
const backToWork = runPermitAction(freshId, '开工')
check('已终结回不到作业中', !backToWork.ok && backToWork.message.includes('只能补附件'))
const attach = appendAttachment(freshId, '气体复测报告')
check('已终结可补附件', attach.ok && String(listPermits().find((p) => p['票号'] === freshNo)!['附件']).includes('气体复测报告'))

// ---- 监护人冲突裁决：受限空间优先 ----
const dh = listPermits().find((p) => p['票号'] === 'DH-2026-1004-01')!
const sx = listPermits().find((p) => p['票号'] === 'SX-2026-1004-01')!
const issueDh = runPermitAction(Number(dh.id), '签发')
check('动火票先签发成功', issueDh.ok, issueDh.message)
const issueSx = runPermitAction(Number(sx.id), '签发')
check('受限空间签发成功（挤掉动火）', issueSx.ok, issueSx.message)
check('裁决理由写进签发说明', String(listPermits().find((p) => p['票号'] === 'SX-2026-1004-01')!['签发说明']).includes('受限空间优先'))
check('被动火票挤回待检测', listPermits().find((p) => p['票号'] === 'DH-2026-1004-01')!.status === '待检测')
const reIssueDh = runPermitAction(Number(dh.id), '签发')
check('监护人被占时动火再签发被驳回', !reIssueDh.ok && reIssueDh.message.includes('正监护'), reIssueDh.message)

// ---- 未终结作业数单一口径 ----
const open = countOpenPermits()
const manual = listPermits().filter((p) => p.status !== '终结归档').length
check('未终结作业数口径一致', open === manual, `${open} vs ${manual}`)

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
