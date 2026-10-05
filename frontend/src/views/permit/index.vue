<template>
  <section class="page" data-module="permit">
    <header class="page-head">
      <div>
        <h2>动火与受限空间作业许可</h2>
        <p class="page-desc">
          作业票只能顺着 申请→待检测→已签发→作业中→终结归档 逐级流转；检测没出结论不许签发，监护人没签到不许开工，已终结的票只能补附件。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">登记作业票</button>
        <button class="btn" type="button" @click="migrate">迁移存量纸质票</button>
        <button class="btn" type="button" @click="exportRows">导出作业票清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="showCreate" class="filter-bar create-bar" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>作业类型</span>
        <select v-model="draft.作业类型">
          <option>动火</option>
          <option>受限空间</option>
        </select>
      </label>
      <label class="filter-item">
        <span>作业地点</span>
        <input v-model="draft.作业地点" placeholder="如：掘进面1号仓" />
      </label>
      <label class="filter-item">
        <span>作业内容</span>
        <input v-model="draft.作业内容" placeholder="如：盾体焊缝补焊" />
      </label>
      <label class="filter-item">
        <span>作业日期</span>
        <input v-model="draft.作业日期" type="date" />
      </label>
      <label class="filter-item">
        <span>监护人</span>
        <input v-model="draft.监护人" placeholder="监护人姓名" />
      </label>
      <label class="filter-item">
        <span>申请人</span>
        <input v-model="draft.申请人" placeholder="申请人姓名" />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in stepActions"
              :key="action"
              class="link"
              type="button"
              @click="act(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="addAttachment(row)">补附件</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无作业票，可先登记作业票或迁移存量纸质票</td>
        </tr>
      </tbody>
    </table>

    <section class="record-panel">
      <div class="record-block">
        <h3>气体检测原始记录</h3>
        <form class="filter-bar" @submit.prevent="submitGas">
          <label class="filter-item">
            <span>作业票编号</span>
            <input v-model="gasForm.code" placeholder="如：DH-0001" />
          </label>
          <label class="filter-item">
            <span>检测结论</span>
            <select v-model="gasForm.conclusion">
              <option value="">未出结论</option>
              <option>合格</option>
              <option>不合格</option>
            </select>
          </label>
          <label class="filter-item">
            <span>检测人</span>
            <input v-model="gasForm.detector" placeholder="检测人姓名" />
          </label>
          <button class="btn" type="submit">录入检测</button>
        </form>
        <table class="data-table">
          <thead>
            <tr><th>检测编号</th><th>作业票编号</th><th>检测结论</th><th>检测人</th><th>检测时间</th><th>来源</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in gasRows" :key="String(row.id)">
              <td>{{ row.检测编号 }}</td>
              <td>{{ row.作业票编号 }}</td>
              <td>{{ row.检测结论 || '未出结论' }}</td>
              <td>{{ row.检测人 || '—' }}</td>
              <td>{{ row.检测时间 }}</td>
              <td>{{ row.来源 }}</td>
            </tr>
            <tr v-if="!gasRows.length">
              <td colspan="6" class="empty-state">暂无气体检测记录</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="record-block">
        <h3>监护人签到原始记录</h3>
        <form class="filter-bar" @submit.prevent="submitSignIn">
          <label class="filter-item">
            <span>作业票编号</span>
            <input v-model="signForm.code" placeholder="如：SX-0004" />
          </label>
          <label class="filter-item">
            <span>监护人</span>
            <input v-model="signForm.guardian" placeholder="须与票面监护人一致" />
          </label>
          <button class="btn" type="submit">监护人签到</button>
        </form>
        <table class="data-table">
          <thead>
            <tr><th>签到编号</th><th>作业票编号</th><th>监护人</th><th>签到时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in guardianRows" :key="String(row.id)">
              <td>{{ row.签到编号 }}</td>
              <td>{{ row.作业票编号 }}</td>
              <td>{{ row.监护人 }}</td>
              <td>{{ row.签到时间 }}</td>
            </tr>
            <tr v-if="!guardianRows.length">
              <td colspan="4" class="empty-state">暂无监护人签到记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 张作业票 · 未终结作业数 {{ liveCount }}（与安全巡检页同一份数据）</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  GASCHECK_KEY,
  GUARDIAN_KEY,
  PERMIT_KEY,
  PERMIT_STATUSES,
  advancePermit,
  appendAttachment,
  createPermit,
  listPermits,
  migrateLegacyPermits,
  recordGasCheck,
  recordGuardianSignIn,
  unterminatedPermitCount,
  type PermitDraft,
} from '@/api/permit-service'
import { listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const columns = ['作业票编号', '作业类型', '作业地点', '作业内容', '作业日期', '监护人', '申请人', '签发说明', '附件']
const stepActions = ['送检', '签发', '开工', '终结']
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const gasRows = ref<EntryRow[]>([])
const guardianRows = ref<EntryRow[]>([])
const liveCount = ref(0)
const message = ref('')
const messageOk = ref(false)
const showCreate = ref(false)
const filters = ref<Record<string, string>>({})

const draft = ref<PermitDraft>({
  作业类型: '动火',
  作业地点: '',
  作业内容: '',
  作业日期: '',
  监护人: '',
  申请人: '',
})
const gasForm = ref({ code: '', conclusion: '', detector: '' })
const signForm = ref({ code: '', guardian: '' })

const stats = ref([
  { label: '未终结作业', value: 0 },
  { label: '作业中作业', value: 0 },
  { label: '待检测作业', value: 0 },
  { label: '异常票', value: 0 },
])

const statusSummary = computed(() =>
  PERMIT_STATUSES.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 每次点击生成一个请求号：网络重试、双击等重复提交带同一号码时只生效一次
function newRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function show(result: ActionResult) {
  message.value = result.message
  messageOk.value = result.ok
}

function act(action: string, row: EntryRow) {
  show(advancePermit(Number(row.id), action, newRequestId()))
  reload()
}

function addAttachment(row: EntryRow) {
  const name = window.prompt('附件名称')
  if (!name) {
    return
  }
  show(appendAttachment(Number(row.id), name, newRequestId()))
  reload()
}

function submitCreate() {
  show(createPermit({ ...draft.value }, newRequestId()))
  reload()
}

function submitGas() {
  show(recordGasCheck(gasForm.value.code.trim(), gasForm.value.conclusion, gasForm.value.detector, newRequestId()))
  reload()
}

function submitSignIn() {
  show(recordGuardianSignIn(signForm.value.code.trim(), signForm.value.guardian, newRequestId()))
  reload()
}

function migrate() {
  show(migrateLegacyPermits(newRequestId()))
  reload()
}

function exportRows() {
  downloadEntries(PERMIT_KEY)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function reload() {
  message.value = ''
  rows.value = listPermits(filters.value)
  gasRows.value = listRows(GASCHECK_KEY)
  guardianRows.value = listRows(GUARDIAN_KEY)
  liveCount.value = unterminatedPermitCount()
  const all = listPermits()
  stats.value = [
    { label: '未终结作业', value: liveCount.value },
    { label: '作业中作业', value: all.filter((row) => String(row.status) === '作业中').length },
    { label: '待检测作业', value: all.filter((row) => String(row.status) === '待检测').length },
    { label: '异常票', value: all.filter((row) => row.abnormal).length },
  ]
}

onMounted(reload)
</script>

<style scoped>
.create-bar {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.record-panel {
  display: flex;
  gap: 16px;
  margin-top: 16px;
}
.record-block {
  flex: 1;
}
.record-block h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.row-abnormal td {
  background: #fef3f2;
}
.ok-text {
  color: #067647;
}
select {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 6px;
}
</style>
