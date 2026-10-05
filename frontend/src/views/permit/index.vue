<template>
  <section class="page" data-module="permit">
    <header class="page-head">
      <div>
        <h2>动火与受限空间作业许可</h2>
        <p class="page-desc">
          作业票只能沿 申请 → 待检测 → 已签发 → 作业中 → 终结归档 顺序流转；检测结论与监护人签到以原始记录为准，缺一项整票退回。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">
          {{ showCreate ? '收起登记' : '登记作业票' }}
        </button>
      </div>
    </header>

    <p v-if="migration" class="migration-note">
      {{ migration['迁移时间'] }}　{{ migration['规则说明'] }}（回填 {{ migration['迁移票数'] }} 张，补录检测
      {{ migration['补录检测数'] }} 条、签到 {{ migration['补录签到数'] }} 条，退回 {{ migration['退回票数'] }} 张）
    </p>

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

    <form v-if="showCreate" class="filter-bar" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>作业类型</span>
        <select v-model="createForm.作业类型">
          <option>动火</option>
          <option>受限空间</option>
        </select>
      </label>
      <label class="filter-item">
        <span>作业地点</span>
        <input v-model="createForm.作业地点" placeholder="如：刀盘维修区" />
      </label>
      <label class="filter-item">
        <span>作业日期</span>
        <input v-model="createForm.作业日期" type="date" />
      </label>
      <label class="filter-item">
        <span>申请人</span>
        <input v-model="createForm.申请人" />
      </label>
      <label class="filter-item">
        <span>监护人</span>
        <input v-model="createForm.监护人" />
      </label>
      <button class="btn primary" type="submit">提交申请</button>
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无作业票，可先登记作业票</td>
        </tr>
      </tbody>
    </table>

    <h3>气体检测原始记录（签发的唯一依据）</h3>
    <form class="filter-bar" @submit.prevent="submitGasTest">
      <label class="filter-item">
        <span>票号</span>
        <select v-model="gasForm.票号">
          <option v-for="no in openTicketNos" :key="no" :value="no">{{ no }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>检测人</span>
        <input v-model="gasForm.检测人" />
      </label>
      <label class="filter-item">
        <span>氧气</span>
        <input v-model="gasForm.氧气" placeholder="如 20.8%" />
      </label>
      <label class="filter-item">
        <span>可燃气</span>
        <input v-model="gasForm.可燃气" placeholder="如 0%LEL" />
      </label>
      <label class="filter-item">
        <span>有毒气体</span>
        <input v-model="gasForm.有毒气体" placeholder="如 未检出" />
      </label>
      <label class="filter-item">
        <span>检测结论</span>
        <select v-model="gasForm.检测结论">
          <option>合格</option>
          <option>不合格</option>
        </select>
      </label>
      <button class="btn" type="submit">录入检测</button>
    </form>
    <table class="data-table">
      <thead>
        <tr><th>票号</th><th>检测时间</th><th>检测人</th><th>氧气</th><th>可燃气</th><th>有毒气体</th><th>检测结论</th><th>备注</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in gasTests" :key="String(row.id)">
          <td>{{ row['票号'] }}</td>
          <td>{{ row['检测时间'] }}</td>
          <td>{{ row['检测人'] }}</td>
          <td>{{ row['氧气'] }}</td>
          <td>{{ row['可燃气'] }}</td>
          <td>{{ row['有毒气体'] }}</td>
          <td>{{ row['检测结论'] }}</td>
          <td>{{ row['备注'] || '—' }}</td>
        </tr>
        <tr v-if="!gasTests.length">
          <td colspan="8" class="empty-state">暂无气体检测原始记录</td>
        </tr>
      </tbody>
    </table>

    <h3>监护人签到原始记录（开工的唯一依据）</h3>
    <form class="filter-bar" @submit.prevent="submitCheckin">
      <label class="filter-item">
        <span>票号</span>
        <select v-model="checkinForm.票号">
          <option v-for="no in openTicketNos" :key="no" :value="no">{{ no }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>监护人</span>
        <input v-model="checkinForm.监护人" placeholder="须与票面监护人一致" />
      </label>
      <button class="btn" type="submit">监护人签到</button>
    </form>
    <table class="data-table">
      <thead>
        <tr><th>票号</th><th>监护人</th><th>签到时间</th><th>备注</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in checkins" :key="String(row.id)">
          <td>{{ row['票号'] }}</td>
          <td>{{ row['监护人'] }}</td>
          <td>{{ row['签到时间'] }}</td>
          <td>{{ row['备注'] || '—' }}</td>
        </tr>
        <tr v-if="!checkins.length">
          <td colspan="4" class="empty-state">暂无监护人签到原始记录</td>
        </tr>
      </tbody>
    </table>

    <h3>整改台账（与安全巡检页同一份数据）</h3>
    <table class="data-table">
      <thead>
        <tr><th>登记时间</th><th>来源票号</th><th>环节</th><th>结论</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in ledger" :key="String(row.id)">
          <td>{{ row['登记时间'] }}</td>
          <td>{{ row['来源票号'] }}</td>
          <td>{{ row['环节'] }}</td>
          <td>{{ row['结论'] }}</td>
        </tr>
        <tr v-if="!ledger.length">
          <td colspan="4" class="empty-state">暂无整改台账记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 张作业票</span>
      <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  appendAttachment,
  createPermit,
  listGasTests,
  listGuardianCheckins,
  listPermits,
  listRectifications,
  migrationReport,
  PERMIT_STAGES,
  permitStats,
  recordGasTest,
  recordGuardianCheckin,
  runPermitAction,
} from '@/api/permit-service'
import type { EntryRow } from '@/data/types'

const columns = ['票号', '作业类型', '作业地点', '作业日期', '申请人', '监护人', '签发说明', '附件']
const actions = ['送检', '签发', '开工', '终结', '补附件']
const filterFields = ['票号', '作业类型', '监护人']

const rows = ref<EntryRow[]>([])
const gasTests = ref<EntryRow[]>([])
const checkins = ref<EntryRow[]>([])
const ledger = ref<EntryRow[]>([])
const stats = ref<{ label: string; value: number }[]>([])
const migration = ref<EntryRow | undefined>(undefined)
const filters = ref<Record<string, string>>({})
const message = ref('')
const messageOk = ref(false)
const showCreate = ref(false)

const createForm = ref({ 作业类型: '动火', 作业地点: '', 作业日期: '', 申请人: '', 监护人: '' })
const gasForm = ref({ 票号: '', 检测人: '', 氧气: '', 可燃气: '', 有毒气体: '', 检测结论: '合格' })
const checkinForm = ref({ 票号: '', 监护人: '' })

const statusSummary = computed(() =>
  PERMIT_STAGES.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 未终结票的票号，给检测/签到录入表单用；allPermits 每次 reload 刷新，下拉跟着走
const allPermits = ref<EntryRow[]>([])
const openTicketNos = computed(() =>
  allPermits.value
    .filter((row) => String(row.status) !== '终结归档')
    .map((row) => String(row['票号'])),
)

function tell(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function submitCreate() {
  const result = createPermit(createForm.value)
  tell(result.ok, result.message)
  if (result.ok) {
    createForm.value = { 作业类型: '动火', 作业地点: '', 作业日期: '', 申请人: '', 监护人: '' }
    showCreate.value = false
  }
  reload()
}

function submitGasTest() {
  const result = recordGasTest(gasForm.value)
  tell(result.ok, result.message)
  reload()
}

function submitCheckin() {
  const result = recordGuardianCheckin(checkinForm.value)
  tell(result.ok, result.message)
  reload()
}

function runAction(action: string, row: EntryRow) {
  if (action === '补附件') {
    const name = window.prompt(`为票 ${row['票号']} 补录附件，请输入附件名称`)
    if (name === null) {
      return
    }
    const result = appendAttachment(Number(row.id), name)
    tell(result.ok, result.message)
    reload()
    return
  }
  const result = runPermitAction(Number(row.id), action)
  tell(result.ok, result.message)
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function reload() {
  rows.value = listPermits(filters.value)
  allPermits.value = listPermits()
  gasTests.value = listGasTests()
  checkins.value = listGuardianCheckins()
  ledger.value = listRectifications()
  stats.value = permitStats()
  migration.value = migrationReport()
}

onMounted(reload)
</script>

<style scoped>
.migration-note {
  background: #eef4ff;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--muted);
}
h3 {
  font-size: 14px;
  margin: 16px 0 8px;
}
select,
input {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
</style>
