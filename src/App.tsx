import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import Chart from 'chart.js/auto'
import type {
  ActiveElement,
  ChartEvent,
  Plugin,
  ScriptableContext,
  TooltipItem,
} from 'chart.js'
import './App.css'

type FilterMode = 'all' | 'pl' | 'wd'

type Entry = {
  label: string
  value: number
  isWithdrawal: boolean
}

type GradientStop = {
  stop: number
  color: string
}

type ImportedData = {
  months?: unknown
  values?: unknown
  withdrawalIndexes?: unknown
}

type ExportData = {
  months: string[]
  values: number[]
  withdrawalIndexes: number[]
}

type SavedFileRecord = {
  id: string
  name: string
  importedAt: string
  data: ExportData
}

type LineChart = Chart<'line', (number | null)[], string>

type SessionWindow = {
  name: string
  startUtc: string
  endUtc: string
  accent: string
}

type SessionStatus = SessionWindow & {
  isOpen: boolean
  nextLabel: string
  displayStart: string
  displayEnd: string
  strength: 'Prime' | 'Building' | 'Cooling' | 'Closed'
  marketStrength: 'Strong' | 'Moderate' | 'Weak'
}

type Settings = {
  theme: 'dark' | 'light' | 'contrast'
  fontScale: number
  timeZone: string
}

type ProfilePreferences = {
  timezone: string
  locale: string
  theme: 'dark' | 'light' | 'contrast'
  fontScale: number
  reducedMotion: boolean
  emailAlerts: boolean
  pushAlerts: boolean
  quietHours: string
  securityAlerts: boolean
}

type UserSession = {
  username: string
}

type UserAccount = {
  username: string
  passwordHash: string
}

const MONTH_OPTIONS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

function formatMoney(value: number, formatter: Intl.NumberFormat): string {
  return formatter.format(value)
}

function getLineGradient(
  context: ScriptableContext<'line'>,
  stops: GradientStop[],
): string | CanvasGradient {
  const { chart } = context
  const { ctx, chartArea } = chart

  if (!chartArea) {
    return stops[0]?.color ?? '#22d3ee'
  }

  const gradient = ctx.createLinearGradient(
    chartArea.left,
    chartArea.top,
    chartArea.right,
    chartArea.top,
  )

  for (const stop of stops) {
    gradient.addColorStop(stop.stop, stop.color)
  }

  return gradient
}

function parseImportedData(data: ImportedData): Entry[] {
  if (!Array.isArray(data.months) || !Array.isArray(data.values)) {
    throw new Error('Invalid import format')
  }

  if (data.months.length !== data.values.length) {
    throw new Error('Mismatched data length')
  }

  const months = data.months.map((value) => String(value))
  const values = data.values.map((value) => Number(value))

  if (values.some((value) => Number.isNaN(value))) {
    throw new Error('Invalid numeric value in import')
  }

  const withdrawalIndexes = new Set<number>(
    Array.isArray(data.withdrawalIndexes)
      ? data.withdrawalIndexes
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0)
      : [],
  )

  return months.map((label, index) => ({
    label,
    value: values[index],
    isWithdrawal: withdrawalIndexes.has(index),
  }))
}

function buildExportData(entries: Entry[]): ExportData {
  return {
    months: entries.map((entry) => entry.label),
    values: entries.map((entry) => entry.value),
    withdrawalIndexes: entries
      .map((entry, index) => (entry.isWithdrawal ? index : -1))
      .filter((index) => index >= 0),
  }
}

function todayDateFields(): { month: string; day: string } {
  const now = new Date()
  return {
    month: now.toLocaleString('en-US', { month: 'long' }),
    day: String(now.getDate()).padStart(2, '0'),
  }
}

function parseMonthDayLabel(label: string): { month: string; day: string } | null {
  const match = /^([A-Za-z]+)\s+(\d{1,2})$/.exec(label.trim())
  if (!match) {
    return null
  }

  return {
    month: match[1],
    day: match[2],
  }
}

const SESSION_WINDOWS: SessionWindow[] = [
  { name: 'Sydney', startUtc: '21:00', endUtc: '06:00', accent: '#a855f7' },
  { name: 'Tokyo', startUtc: '00:00', endUtc: '09:00', accent: '#22d3ee' },
  { name: 'London', startUtc: '08:00', endUtc: '17:00', accent: '#34d399' },
  { name: 'New York', startUtc: '13:00', endUtc: '22:00', accent: '#f59e0b' },
]

const PHT_OFFSET_MINUTES = 8 * 60 // UTC+8
const DISPLAY_TIMEZONE_LABEL = 'PHT (UTC+8)'
const SAVED_FILES_STORAGE_KEY = 'trading-journey:saved-imports'
const USER_STORAGE_KEY = 'trading-journey:user'
const USERS_STORAGE_KEY = 'trading-journey:users'
const MAX_SAVED_FILES = 30
const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontScale: 1,
  timeZone: 'Asia/Manila',
}

function parseUtcToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map((value) => Number(value))
  return hours * 60 + minutes
}

function diffMinutes(nowMinutes: number, targetMinutes: number): number {
  const diff = targetMinutes - nowMinutes
  return diff >= 0 ? diff : diff + 24 * 60
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) {
    return `${mins}m`
  }
  if (mins === 0) {
    return `${hours}h`
  }
  return `${hours}h ${mins}m`
}

function toClockLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24
  const mins = minutes % 60
  const hours12 = ((hours + 11) % 12) + 1
  const suffix = hours >= 12 ? 'PM' : 'AM'
  return `${hours12}:${String(mins).padStart(2, '0')} ${suffix}`
}

function normalizeSavedFileRecord(raw: unknown): SavedFileRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const candidate = raw as Partial<SavedFileRecord>
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.importedAt !== 'string'
  ) {
    return null
  }

  try {
    const normalizedEntries = parseImportedData((candidate as { data?: ImportedData }).data ?? {})
    return {
      id: candidate.id,
      name: candidate.name,
      importedAt: candidate.importedAt,
      data: buildExportData(normalizedEntries),
    }
  } catch {
    return null
  }
}

function formatSavedFileDate(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date'
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function getSavedFilesKey(username?: string | null): string {
  return `${SAVED_FILES_STORAGE_KEY}:${username ?? 'anon'}`
}

function loadSavedFilesFromStorage(username?: string | null): SavedFileRecord[] {
  try {
    const raw = window.localStorage.getItem(getSavedFilesKey(username))
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .map((item) => normalizeSavedFileRecord(item))
      .filter((item): item is SavedFileRecord => item !== null)
      .slice(0, MAX_SAVED_FILES)
  } catch {
    return []
  }
}

function loadUserFromStorage(): UserSession | null {
  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const username = (parsed as { username?: unknown }).username
    if (typeof username !== 'string') return null
    return { username }
  } catch {
    return null
  }
}

function loadUsersFromStorage(): UserAccount[] {
  try {
    const raw = window.localStorage.getItem(USERS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as { username?: unknown }).username === 'string' &&
          typeof (item as { passwordHash?: unknown }).passwordHash === 'string'
        ) {
          return { username: (item as { username: string }).username, passwordHash: (item as { passwordHash: string }).passwordHash }
        }
        return null
      })
      .filter((item): item is UserAccount => item !== null)
  } catch {
    return []
  }
}

function saveUsersToStorage(users: UserAccount[]): void {
  try {
    window.localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users))
  } catch {
    // ignore
  }
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function buildSessionStatuses(now: Date): SessionStatus[] {
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()

  return SESSION_WINDOWS.map((session) => {
    const start = parseUtcToMinutes(session.startUtc)
    const end = parseUtcToMinutes(session.endUtc)

    const spansMidnight = end < start
    const isOpen = spansMidnight
      ? nowMinutes >= start || nowMinutes < end
      : nowMinutes >= start && nowMinutes < end

    const normalizedEnd = spansMidnight && nowMinutes < start ? end + 24 * 60 : end
    const normalizedStart = start
    const normalizedNow = spansMidnight && nowMinutes < start ? nowMinutes + 24 * 60 : nowMinutes
    const sessionDuration = normalizedEnd - normalizedStart
    const elapsed = Math.max(0, Math.min(sessionDuration, normalizedNow - normalizedStart))
    const progress = sessionDuration > 0 ? elapsed / sessionDuration : 0

    let strength: SessionStatus['strength'] = 'Closed'
    if (isOpen) {
      if (progress > 0.25 && progress < 0.75) {
        strength = 'Prime'
      } else if (progress <= 0.25) {
        strength = 'Building'
      } else {
        strength = 'Cooling'
      }
    }

    let nextEventMinutes: number
    let nextLabel: string

    if (isOpen) {
      nextEventMinutes = end
      const closesIn = diffMinutes(nowMinutes, nextEventMinutes)
      nextLabel = `closes in ${formatDuration(closesIn)}`
    } else {
      nextEventMinutes = start
      const opensIn = diffMinutes(nowMinutes, nextEventMinutes)
      nextLabel = `opens in ${formatDuration(opensIn)}`
    }

    const displayStartMinutes = (start + PHT_OFFSET_MINUTES) % (24 * 60)
    const displayEndMinutes = (end + PHT_OFFSET_MINUTES) % (24 * 60)

    return {
      ...session,
      isOpen,
      nextLabel,
      displayStart: `${toClockLabel(displayStartMinutes)}`,
      displayEnd: `${toClockLabel(displayEndMinutes)}`,
      strength,
      marketStrength:
        strength === 'Prime'
          ? 'Strong'
          : strength === 'Building'
            ? 'Moderate'
            : 'Weak',
    }
  })
}


function App() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [user, setUser] = useState<UserSession | null>(() => loadUserFromStorage())
  const [users, setUsers] = useState<UserAccount[]>(() => loadUsersFromStorage())
  const [savedFiles, setSavedFiles] = useState<SavedFileRecord[]>([])
  const [savedFilesOpen, setSavedFilesOpen] = useState(false)
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const settings = DEFAULT_SETTINGS

  const [nowUtc, setNowUtc] = useState<Date>(() => new Date())
  const [monthInput, setMonthInput] = useState('')
  const [dayInput, setDayInput] = useState('')
  const [valueInput, setValueInput] = useState('')

  const [withdrawMonthInput, setWithdrawMonthInput] = useState('')
  const [withdrawDayInput, setWithdrawDayInput] = useState('')
  const [withdrawValueInput, setWithdrawValueInput] = useState('')

  const [chartError, setChartError] = useState('')
  const [usernameInput, setUsernameInput] = useState(user?.username ?? '')
  const [passwordInput, setPasswordInput] = useState('')
  const [authError, setAuthError] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [showPassword, setShowPassword] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'dashboard' | 'profile'>('dashboard')
  const [profilePrefs, setProfilePrefs] = useState<ProfilePreferences>({
    timezone: DEFAULT_SETTINGS.timeZone,
    locale: 'en-US',
    theme: 'dark',
    fontScale: 1,
    reducedMotion: false,
    emailAlerts: true,
    pushAlerts: false,
    quietHours: '',
    securityAlerts: true,
  })
  const menuRef = useRef<HTMLDivElement | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<LineChart | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const rafHandleRef = useRef<number | null>(null)
  const entriesRef = useRef<Entry[]>([])
  entriesRef.current = entries

  const moneyFormatter = useMemo(
    () =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
        minimumFractionDigits: 0,
      }),
    [],
  )

  useEffect(() => {
    document.body.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--font-scale', settings.fontScale.toString())
  }, [settings])

  useEffect(() => {
    if (!savedFilesOpen) {
      return undefined
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [savedFilesOpen])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowUtc(new Date())
    }, 15_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [user, viewMode])

  const queueChartUpdate = useCallback(() => {
    if (rafHandleRef.current !== null) {
      return
    }

    rafHandleRef.current = window.requestAnimationFrame(() => {
      chartRef.current?.update()
      rafHandleRef.current = null
    })
  }, [])

  const hydrateChartFromEntries = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    const list = entriesRef.current

    chart.data.labels = list.map((entry) => entry.label)
    chart.data.datasets[0].data = list.map((entry) => entry.value)
    chart.data.datasets[1].data = list.map((entry, index) => {
      if (entry.isWithdrawal || index === 0) return null
      const previous = list[index - 1]
      return entry.value < previous.value ? entry.value : null
    })
    chart.data.datasets[1].hidden = true

    queueChartUpdate()
  }, [queueChartUpdate])

  const applyDateFields = useCallback((month: string, day: string) => {
    setMonthInput(month)
    setDayInput(day)
    setWithdrawMonthInput(month)
    setWithdrawDayInput(day)
  }, [])

  const setDateFieldsToToday = useCallback(() => {
    const { month, day } = todayDateFields()
    applyDateFields(month, day)
  }, [applyDateFields])

  const applyImportedEntries = useCallback(
    (importedEntries: Entry[]) => {
      setEntries(importedEntries)

      const latestLabel = importedEntries[importedEntries.length - 1]?.label
      const parsedDate = latestLabel ? parseMonthDayLabel(latestLabel) : null
      if (parsedDate) {
        applyDateFields(parsedDate.month, parsedDate.day)
      } else {
        setDateFieldsToToday()
      }
    },
    [applyDateFields, setDateFieldsToToday],
  )

  useEffect(() => {
    if (!user) {
      try {
        window.localStorage.removeItem(USER_STORAGE_KEY)
      } catch {
        // ignore storage issues
      }
      setSavedFiles([])
      return
    }
    try {
      window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
    } catch {
      // ignore storage issues
    }
    setSavedFiles(loadSavedFilesFromStorage(user.username))
  }, [user])

  useEffect(() => {
    setMenuOpen(false)
  }, [user])

  useEffect(() => {
    if (!menuOpen) return undefined

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  useEffect(() => {
    saveUsersToStorage(users)
  }, [users])

  useEffect(() => {
    if (user || usernameInput.trim()) return
    const remembered = users[0]?.username
    if (remembered) {
      setUsernameInput(remembered)
    }
  }, [user, users, usernameInput])

  useEffect(() => {
    if (!user) return
    try {
      window.localStorage.setItem(getSavedFilesKey(user.username), JSON.stringify(savedFiles))
    } catch {
      // ignore storage write issues
    }
  }, [savedFiles, user])

  useEffect(() => {
    let cancelled = false

    const loadInitialData = async () => {
      try {
        const response = await fetch('/monthly_income_data.json', {
          cache: 'no-store',
        })

        if (!response.ok) {
          throw new Error('Default data file not found')
        }

        const imported = (await response.json()) as ImportedData
        const loadedEntries = parseImportedData(imported)

        if (cancelled) {
          return
        }

        applyImportedEntries(loadedEntries)
      } catch {
        if (!cancelled) {
          setDateFieldsToToday()
        }
      }
    }

    void loadInitialData()

    return () => {
      cancelled = true
    }
  }, [applyImportedEntries, setDateFieldsToToday])

  useEffect(() => {
    if (!user || viewMode !== 'dashboard') {
      if (chartRef.current) {
        chartRef.current.destroy()
        chartRef.current = null
      }
      if (rafHandleRef.current !== null) {
        window.cancelAnimationFrame(rafHandleRef.current)
        rafHandleRef.current = null
      }
      return undefined
    }

    const canvas = canvasRef.current
    if (!canvas) {
      return undefined
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setChartError('Unable to initialize chart canvas.')
      return undefined
    }

    const blendPlugin: Plugin<'line'> = {
      id: 'blendPlugin',
      beforeDatasetsDraw(chart) {
        chart.ctx.save()
        chart.ctx.globalCompositeOperation = 'screen'
      },
      afterDatasetsDraw(chart) {
        chart.ctx.restore()
      },
    }

    const shineOverlay: Plugin<'line'> = {
      id: 'shineOverlay',
      afterDatasetsDraw(chart) {
        const { ctx: overlayCtx, chartArea } = chart
        if (!chartArea) return

        const shineGradient = overlayCtx.createRadialGradient(
          chartArea.right - (chartArea.width * 0.25),
          chartArea.top + (chartArea.height * 0.35),
          chartArea.width * 0.05,
          chartArea.right - (chartArea.width * 0.25),
          chartArea.top + (chartArea.height * 0.35),
          chartArea.width * 0.6,
        )

        shineGradient.addColorStop(0, 'rgba(255,255,255,0.23)')
        shineGradient.addColorStop(0.35, 'rgba(255,255,255,0.12)')
        shineGradient.addColorStop(1, 'rgba(255,255,255,0)')

        overlayCtx.save()
        overlayCtx.globalCompositeOperation = 'lighter'
        overlayCtx.fillStyle = shineGradient
        overlayCtx.fillRect(chartArea.left, chartArea.top, chartArea.width, chartArea.height)
        overlayCtx.restore()
      },
    }

    const chart = new Chart(ctx, {
      type: 'line',
      plugins: [blendPlugin, shineOverlay],
      data: {
        labels: [],
        datasets: [
          {
            label: 'Profit',
            data: [],
            borderColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: '#5be1ff' },
                { stop: 0.5, color: '#2fc8ff' },
                { stop: 1, color: '#09a8f0' },
              ]),
            backgroundColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: 'rgba(91, 225, 255, 0.18)' },
                { stop: 1, color: 'rgba(9, 168, 240, 0.12)' },
              ]),
            borderWidth: 1.7,
            tension: 0.22,
            cubicInterpolationMode: 'monotone',
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHitRadius: 12,
            pointBorderWidth: 2,
            pointBackgroundColor: '#48d8ff',
            pointBorderColor: '#0c2635',
            fill: true,
            segment: {
              borderColor: (context) => {
                const currentIndex = context.p1DataIndex
                const current = Number(context.p1.parsed.y)
                const previous = Number(context.p0.parsed.y)
                if (entriesRef.current[currentIndex]?.isWithdrawal) {
                  return '#22c55e'
                }
                return current < previous ? '#ff5f6d' : '#38bdf8'
              },
              backgroundColor: (context) => {
                const currentIndex = context.p1DataIndex
                const current = Number(context.p1.parsed.y)
                const previous = Number(context.p0.parsed.y)
                if (entriesRef.current[currentIndex]?.isWithdrawal) {
                  return 'rgba(34, 197, 94, 0.18)'
                }
                return current < previous
                  ? 'rgba(255, 95, 109, 0.18)'
                  : 'rgba(56, 189, 248, 0.16)'
              },
            },
          },
          {
            label: 'Loss',
            data: [],
            borderColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: '#ff6b7a' },
                { stop: 1, color: '#f33f5a' },
              ]),
            backgroundColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: 'rgba(255, 107, 122, 0.24)' },
                { stop: 1, color: 'rgba(243, 63, 90, 0.18)' },
              ]),
            pointRadius: 0,
            pointHoverRadius: 0,
            pointBorderWidth: 0,
            pointBorderColor: 'transparent',
            showLine: false,
          },
        ],
      },
      options: {
        responsive: true,
        spanGaps: true,
        interaction: { intersect: false, mode: 'nearest' },
        layout: { padding: { top: 8, right: 12, bottom: 8, left: 12 } },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.07)' },
            ticks: {
              color: 'rgba(229,231,235,0.72)',
              callback(value) {
                return formatMoney(Number(value), moneyFormatter)
              },
            },
          },
          x: {
            grid: { display: false },
            ticks: {
              color: 'rgba(229,231,235,0.65)',
              maxRotation: 14,
              minRotation: 0,
              autoSkip: true,
            },
          },
        },
        elements: {
          line: {
            borderWidth: 2.2,
            tension: 0.22,
          },
          point: {
            radius: 0,
            hoverRadius: 6,
            hitRadius: 12,
            borderWidth: 2,
            backgroundColor: '#48d8ff',
            borderColor: '#0c2635',
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(12,18,32,0.94)',
            borderColor: 'rgba(34,211,238,0.35)',
            borderWidth: 1,
            padding: 12,
            displayColors: false,
            callbacks: {
              title(context) {
                return context[0]?.label ?? ''
              },
              label(context: TooltipItem<'line'>) {
                const index = context.dataIndex
                const data = context.dataset.data as number[]
                const current = Number(data[index])
                if (index === 0) {
                  return `Price: ${formatMoney(current, moneyFormatter)}`
                }
                const previous = Number(data[index - 1])
                const difference = current - previous
                const percent = previous === 0 ? 0 : (difference / previous) * 100
                const dir = difference >= 0 ? 'Increase' : 'Decrease'
                const arrow = difference >= 0 ? '▲' : '▼'
                return `${arrow} ${dir}: ${difference >= 0 ? '+' : ''}${formatMoney(difference, moneyFormatter)} (${percent.toFixed(2)}%)`
              },
              labelTextColor() {
                return '#e5f2ff'
              },
            },
          },
        },
      },
    })

    chart.options.onHover = (_event: ChartEvent, elements: ActiveElement[]) => {
      if (elements.length === 0) {
        return
      }
      setActiveIndex(elements[0].index)
    }

    chartRef.current = chart
    hydrateChartFromEntries()
    setChartError('')

    return () => {
      chart.destroy()
      chartRef.current = null
      if (rafHandleRef.current !== null) {
        window.cancelAnimationFrame(rafHandleRef.current)
        rafHandleRef.current = null
      }
    }
  }, [user, viewMode, hydrateChartFromEntries])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) {
      return
    }

    chart.data.labels = entries.map((entry) => entry.label)
    chart.data.datasets[0].data = entries.map((entry) => entry.value)
    chart.data.datasets[1].data = entries.map((entry, index) => {
      if (entry.isWithdrawal || index === 0) return null
      const previous = entries[index - 1]
      return entry.value < previous.value ? entry.value : null
    })

    queueChartUpdate()
  }, [entries, queueChartUpdate])

  const setActiveChartPoint = useCallback(
    (index: number | null) => {
      setActiveIndex(index)

      const chart = chartRef.current
      if (!chart) {
        return
      }

      chart.setActiveElements(
        index === null ? [] : [{ datasetIndex: 0, index }],
      )
      queueChartUpdate()
    },
    [queueChartUpdate],
  )

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()

    return entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        if (filterMode === 'pl' && entry.isWithdrawal) {
          return false
        }
        if (filterMode === 'wd' && !entry.isWithdrawal) {
          return false
        }
        if (term && !entry.label.toLowerCase().includes(term)) {
          return false
        }
        return true
      })
  }, [entries, filterMode, searchTerm])

  const sessionStatuses = useMemo(() => buildSessionStatuses(nowUtc), [nowUtc])
  const openSessions = sessionStatuses.filter((session) => session.isOpen)
  const overallMarketStrength = useMemo<SessionStatus['marketStrength']>(() => {
    const openNames = new Set(openSessions.map((s) => s.name))
    const hasSydney = openNames.has('Sydney')
    const hasTokyo = openNames.has('Tokyo')
    const hasLondon = openNames.has('London')
    const hasNewYork = openNames.has('New York')

    // Explicit combinations requested
    if (hasSydney && hasNewYork && !hasLondon && !hasTokyo) return 'Weak'
    if (hasSydney && hasTokyo && !hasLondon) return 'Moderate'
    if (hasTokyo && hasLondon) return 'Strong'
    if (hasLondon && hasNewYork) return 'Strong'

    // Single-session fallbacks
    if (hasLondon) return 'Strong'
    if (hasNewYork) return 'Strong'
    if (hasTokyo) return 'Moderate'
    if (hasSydney) return 'Weak'

    return 'Weak'
  }, [openSessions])
  const nowPhtLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: settings.timeZone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(nowUtc),
    [nowUtc, settings.timeZone],
  )

  const addData = useCallback(() => {
    const month = monthInput
    const day = dayInput.trim()
    const rawAmount = valueInput.trim()
    const amount = Number(rawAmount)

    if (!month || !day || !rawAmount || Number.isNaN(amount)) {
      window.alert('Select a month, enter a day, and amount.')
      return
    }

    setEntries((previous) => [
      ...previous,
      {
        label: `${month} ${day}`,
        value: amount,
        isWithdrawal: false,
      },
    ])

    setMonthInput('')
    setDayInput('')
    setValueInput('')
  }, [dayInput, monthInput, valueInput])

  const addWithdrawal = useCallback(() => {
    const month = withdrawMonthInput
    const day = withdrawDayInput.trim()
    const rawAmount = withdrawValueInput.trim()
    const amount = Number(rawAmount)

    if (!month || !day || !rawAmount || Number.isNaN(amount) || amount <= 0) {
      window.alert('Select a withdraw month, enter a day, and amount.')
      return
    }

    if (entries.length === 0) {
      window.alert('Add data first before withdrawing.')
      return
    }

    const lastValue = entries[entries.length - 1].value

    setEntries((previous) => [
      ...previous,
      {
        label: `${month} ${day}`,
        value: lastValue - amount,
        isWithdrawal: true,
      },
    ])

    setWithdrawMonthInput('')
    setWithdrawDayInput('')
    setWithdrawValueInput('')
  }, [entries, withdrawDayInput, withdrawMonthInput, withdrawValueInput])

  const clearData = useCallback(() => {
    setEntries([])
    setActiveChartPoint(null)
  }, [setActiveChartPoint])

  const exportJson = useCallback(() => {
    const exportData = buildExportData(entries)

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    })

    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'monthly_income_data.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }, [entries])

  const importJson = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) {
        return
      }

      const reader = new FileReader()
      reader.onload = (loadEvent) => {
        try {
          const content = String(loadEvent.target?.result ?? '')
          const parsed = JSON.parse(content) as ImportedData
          const importedEntries = parseImportedData(parsed)
          const exported = buildExportData(importedEntries)
          applyImportedEntries(importedEntries)

          setSavedFiles((previous) => {
            const fingerprint = `${file.name}:${JSON.stringify(exported)}`
            const deduped = previous.filter(
              (item) => `${item.name}:${JSON.stringify(item.data)}` !== fingerprint,
            )

            return [
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: file.name,
                importedAt: new Date().toISOString(),
                data: exported,
              },
              ...deduped,
            ].slice(0, MAX_SAVED_FILES)
          })
        } catch {
          window.alert('Error reading JSON file.')
        }
      }

      reader.readAsText(file)
      event.target.value = ''
    },
    [applyImportedEntries],
  )

  const openImportFileDialog = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const loadSavedFile = useCallback(
    (savedFile: SavedFileRecord) => {
      try {
        const importedEntries = parseImportedData(savedFile.data)
        applyImportedEntries(importedEntries)
        setSavedFilesOpen(false)
      } catch {
        setSavedFiles((previous) => previous.filter((item) => item.id !== savedFile.id))
        window.alert('Saved file is invalid and was removed.')
      }
    },
    [applyImportedEntries],
  )

  const deleteSavedFile = useCallback((savedFileId: string) => {
    setSavedFiles((previous) => previous.filter((item) => item.id !== savedFileId))
  }, [])

  const renameSavedFile = useCallback((savedFile: SavedFileRecord) => {
    const next = window.prompt('Enter a new name for this saved file:', savedFile.name)
    if (!next) return
    const trimmed = next.trim()
    if (!trimmed) return
    setSavedFiles((previous) =>
      previous.map((item) => (item.id === savedFile.id ? { ...item, name: trimmed } : item)),
    )
  }, [])

  const saveCurrentSnapshot = useCallback(() => {
    if (!user) {
      window.alert('You must be signed in to save your work.')
      return
    }
    if (entries.length === 0) {
      window.alert('No data to save yet.')
      return
    }

    const exported = buildExportData(entries)
    const fingerprint = JSON.stringify(exported)

    setSavedFiles((previous) => {
      const deduped = previous.filter((item) => JSON.stringify(item.data) !== fingerprint)
      const timestamp = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date())
      return [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: `Snapshot ${timestamp}`,
          importedAt: new Date().toISOString(),
          data: exported,
        },
        ...deduped,
      ].slice(0, MAX_SAVED_FILES)
    })
  }, [entries, user])

  const handleLogin = useCallback(async () => {
    const trimmed = usernameInput.trim()
    const password = passwordInput.trim()
    if (!trimmed || !password) {
      setAuthError('Username and password are required.')
      return
    }

    const candidate = users.find((account) => account.username === trimmed)
    if (!candidate) {
      setAuthError('Account not found.')
      return
    }

    const candidateHash = await hashPassword(password)
    if (candidateHash !== candidate.passwordHash) {
      setAuthError('Invalid credentials.')
      return
    }

    setUser({ username: trimmed })
    setViewMode('dashboard')
    setAuthError('')
    setPasswordInput('')
  }, [passwordInput, usernameInput, users])

  const handleSignup = useCallback(async () => {
    const trimmed = usernameInput.trim()
    const password = passwordInput.trim()
    if (!trimmed || !password) {
      setAuthError('Username and password are required.')
      return
    }
    if (trimmed.length < 3) {
      setAuthError('Username must be at least 3 characters.')
      return
    }
    if (password.length < 6) {
      setAuthError('Password must be at least 6 characters.')
      return
    }
    if (users.some((account) => account.username === trimmed)) {
      setAuthError('Username already exists.')
      return
    }

    const passwordHash = await hashPassword(password)
    setUsers((previous) => [...previous, { username: trimmed, passwordHash }])
    setUser({ username: trimmed })
    setAuthError('')
    setPasswordInput('')
    setSavedFiles([])
  }, [passwordInput, usernameInput, users])

  const handleLogout = useCallback(() => {
    setUser(null)
    setEntries([])
    setSavedFiles([])
    setSavedFilesOpen(false)
    setViewMode('dashboard')
    setUsernameInput('')
    setPasswordInput('')
    try {
      window.localStorage.removeItem(USER_STORAGE_KEY)
    } catch {
      // ignore
    }
  }, [])

  const captureChart = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const link = document.createElement('a')
    link.download = 'trading-chart.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [])

  const footerBalance =
    entries.length > 0 ? formatMoney(entries[entries.length - 1].value, moneyFormatter) : '--'
  const footerUpdated = entries.length > 0 ? entries[entries.length - 1].label : '--'
  const footerEntryCount = useMemo(
    () => entries.filter((entry, index) => !entry.isWithdrawal && index !== 0).length,
    [entries],
  )
  const activityFeed = useMemo(
    () =>
      entries.slice(-10).map((entry, idx) => ({
        id: `${entry.label}-${idx}`,
        label: entry.label,
        value: entry.value,
        type: entry.isWithdrawal ? 'Withdrawal' : idx === 0 ? 'Deposit' : 'Update',
        delta: idx === 0 ? null : entry.value - entries[idx - 1].value,
        when: idx === entries.length - 1 ? 'Just now' : `${entries.length - idx - 1} step(s) ago`,
      })),
    [entries],
  )

  if (!user) {
    return (
      <div className="auth-shell">
        <div className="auth-card pro-card">
          <div className="auth-card-head brand-row">
            <div className="brand-dot" aria-hidden="true" />
            <div className="auth-overline">Secure Portal</div>
          </div>
          <h2 className="auth-title-main">Trading Journal</h2>
          <p className="auth-subtitle">Access your timelines, saved files, and session tools securely.</p>

          <div className="auth-pill-row">
            <div className="auth-pill">Role-aware access</div>
            <div className="auth-pill">Encrypted at rest</div>
            <div className="auth-pill">Session recovery</div>
          </div>

          <div className="auth-form">
            <div className="auth-form-head">
              <div className="auth-overline">{authMode === 'login' ? 'Welcome back' : 'Create your account'}</div>
              <h3 className="auth-title">{authMode === 'login' ? 'Sign In' : 'Sign Up'}</h3>
              <p className="auth-subtitle-small">Use your credentials to continue.</p>
            </div>

            <div className="form-stack">
              <label className="form-label" htmlFor="usernameInputAuth">
                Username
                <div className="input-with-icon">
                  <span className="input-icon" aria-hidden="true">👤</span>
                  <input
                    id="usernameInputAuth"
                    type="text"
                    value={usernameInput}
                    onChange={(event) => setUsernameInput(event.target.value)}
                    autoComplete="username"
                  />
                </div>
              </label>

              <label className="form-label" htmlFor="passwordInputAuth">
                Password
                <div className="input-with-icon">
                  <span className="input-icon" aria-hidden="true">🔒</span>
                  <input
                    id="passwordInputAuth"
                    type={showPassword ? 'text' : 'password'}
                    value={passwordInput}
                    onChange={(event) => setPasswordInput(event.target.value)}
                    autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  />
                  <button
                    type="button"
                    className="eye-toggle"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <span className="helper-text">Use 8+ characters with a number.</span>
              </label>
            </div>

            {authError ? <p className="auth-error">{authError}</p> : null}

            <div className="cta-stack cta-row">
              <button
                type="button"
                className="btn btn-primary cta-primary"
                onClick={authMode === 'login' ? handleLogin : handleSignup}
              >
                {authMode === 'login' ? 'Login' : 'Sign Up'}
              </button>
              <button
                type="button"
                className="btn btn-secondary cta-secondary"
                onClick={() => {
                  setAuthError('')
                  setAuthMode(authMode === 'login' ? 'signup' : 'login')
                }}
              >
                {authMode === 'login' ? 'Create account' : 'Back to login'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (viewMode === 'profile') {
    const avatarLetter = (user?.username ?? '?').slice(0, 1).toUpperCase()
    const activeSessions = [
      { id: 'current', device: 'This device', ip: '127.0.0.1', lastSeen: 'Just now', current: true },
      { id: 'mobile', device: 'Mobile', ip: '10.0.0.5', lastSeen: '2 days ago', current: false },
    ]

    return (
      <div className="container profile-shell">
        <div className="profile-header">
          <div>
            <div className="auth-overline">Profile</div>
            <h2 className="profile-title">Account & Security</h2>
          </div>
          <div className="profile-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setViewMode('dashboard')}
            >
              Back to dashboard
            </button>
          </div>
        </div>

        <div className="profile-grid">
          <div className="profile-card">
            <div className="profile-card-head">
              <h3>Identity</h3>
              <span className="pill subtle">Basics</span>
            </div>
            <div className="profile-identity">
              <div className="avatar">{avatarLetter}</div>
              <div className="identity-fields">
                <div className="field">
                  <label>Username</label>
                  <div className="readonly">{user?.username}</div>
                </div>
                <div className="field">
                  <label>Timezone</label>
                  <select
                    value={profilePrefs.timezone}
                    onChange={(e) =>
                      setProfilePrefs((p) => ({ ...p, timezone: e.target.value }))
                    }
                  >
                    <option value="Asia/Manila">Asia/Manila</option>
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">America/New_York</option>
                    <option value="Europe/London">Europe/London</option>
                  </select>
                </div>
                <div className="field">
                  <label>Locale</label>
                  <select
                    value={profilePrefs.locale}
                    onChange={(e) => setProfilePrefs((p) => ({ ...p, locale: e.target.value }))}
                  >
                    <option value="en-US">English (US)</option>
                    <option value="en-GB">English (UK)</option>
                    <option value="ja-JP">日本語</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div className="profile-card">
            <div className="profile-card-head">
              <h3>Security</h3>
              <span className="pill warning">Protect</span>
            </div>
            <div className="profile-security">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => window.alert('MFA setup flow not yet implemented.')}
              >
                Set up MFA
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => window.alert('Password change flow not yet implemented.')}
              >
                Change password
              </button>
              <div className="sessions">
                <div className="sessions-head">
                  <span>Active sessions</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => window.alert('Revoked other sessions.')}
                  >
                    Sign out others
                  </button>
                </div>
                {activeSessions.map((s) => (
                  <div key={s.id} className="session-row">
                    <div>
                      <div className="session-device">{s.device}</div>
                      <div className="session-meta">
                        {s.ip} · {s.lastSeen}
                      </div>
                    </div>
                    {s.current ? <span className="pill success">Current</span> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="profile-card">
            <div className="profile-card-head">
              <h3>Activity</h3>
              <span className="pill subtle">Recent</span>
            </div>
            <div className="activity-list">
              {activityFeed.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-pill">No recent activity</div>
                  <p>Make updates to see them here.</p>
                </div>
              ) : (
                activityFeed.map((item) => (
                  <div key={item.id} className="activity-row">
                    <div className="activity-main">
                      <div className="activity-type">{item.type}</div>
                      <div className="activity-label">
                        {item.label} · ${item.value}
                      </div>
                    </div>
                    <div className="activity-meta">{item.when}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="profile-card">
            <div className="profile-card-head">
              <h3>Usage</h3>
              <span className="pill subtle">Health</span>
            </div>
            <div className="usage-grid">
              <div className="usage-card">
                <div className="usage-label">Saved files</div>
                <div className="usage-value">
                  {savedFiles.length} / {MAX_SAVED_FILES}
                </div>
              </div>
              <div className="usage-card">
                <div className="usage-label">Entries</div>
                <div className="usage-value">{entries.length}</div>
              </div>
              <div className="usage-card">
                <div className="usage-label">Sessions open</div>
                <div className="usage-value">{openSessions.length}</div>
              </div>
            </div>
          </div>

        </div>

        <div className="profile-footer-actions">
          <div className="profile-actions">
            <button type="button" className="btn btn-primary" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="container">
      <div className="header">
        <h2>Profit Linechart</h2>
        <div className="header-actions">
          <button type="button" className="btn btn-primary capture-btn icon-only" onClick={captureChart}>
            <span className="icon-camera" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M8.5 6.5 10 4h4l1.5 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h3.5Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="18" cy="9" r="0.9" fill="currentColor" />
              </svg>
            </span>
            <span className="visually-hidden">Capture chart</span>
          </button>
          <div className="menu-wrapper" ref={menuRef}>
            <button
              type="button"
              className="burger-btn"
              aria-expanded={menuOpen}
              aria-label="Menu"
              onClick={() => setMenuOpen((prev) => !prev)}
            >
              <span className="burger-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </span>
            </button>
            {menuOpen ? (
              <div className="menu-dropdown">
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setViewMode('profile')
                    setMenuOpen(false)
                  }}
                >
                  Profile
                </button>
                <button type="button" className="menu-item" onClick={exportJson}>
                  Export Data
                </button>
                <button type="button" className="menu-item" onClick={openImportFileDialog}>
                  Import Data
                </button>
                <button type="button" className="menu-item" onClick={() => setSavedFilesOpen(true)}>
                  Saved Files
                </button>
                <button type="button" className="menu-item danger" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            id="importFile"
            accept=".json"
            hidden
            onChange={importJson}
          />
        </div>
      </div>

      <div className="legend legend-inline legend-top">
        <span className="badge badge-up">Profit</span>
        <span className="badge badge-down">Loss</span>
        <span className="badge badge-wd">Withdrawal</span>
      </div>


      <canvas ref={canvasRef} />
      {chartError ? <p className="chart-error">{chartError}</p> : null}
      <div className="chart-actions">
        <button type="button" className="btn btn-secondary chart-save-btn" onClick={saveCurrentSnapshot}>
          Save
        </button>
      </div>

      <div className="filters">
        <div className="toggle-group">
          <button
            type="button"
            className="filter-btn"
            data-filter="all"
            aria-pressed={filterMode === 'all'}
            onClick={() => setFilterMode('all')}
          >
            All
          </button>
          <button
            type="button"
            className="filter-btn"
            data-filter="pl"
            aria-pressed={filterMode === 'pl'}
            onClick={() => setFilterMode('pl')}
          >
            P&amp;L only
          </button>
          <button
            type="button"
            className="filter-btn"
            data-filter="wd"
            aria-pressed={filterMode === 'wd'}
            onClick={() => setFilterMode('wd')}
          >
            Withdrawals only
          </button>
        </div>

        <input
          id="searchInput"
          type="search"
          placeholder="Search month/day..."
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
      </div>

      <div className="controls">
        <select
          id="monthInput"
          className="span-2 month-select"
          value={monthInput}
          onChange={(event) => setMonthInput(event.target.value)}
        >
          <option value="" disabled>
            Select Month
          </option>
          {MONTH_OPTIONS.map((month) => (
            <option key={month} value={month}>
              {month}
            </option>
          ))}
        </select>

        <input
          className="span-1 day-input"
          type="number"
          id="dayInput"
          min={1}
          max={31}
          placeholder="Day"
          value={dayInput}
          onChange={(event) => setDayInput(event.target.value)}
        />

        <input
          className="span-2"
          type="number"
          id="valueInput"
          placeholder="Enter Current Balance ($)"
          value={valueInput}
          onChange={(event) => setValueInput(event.target.value)}
        />

        <button type="button" className="btn btn-primary span-1" onClick={addData}>
          Add
        </button>

        <button type="button" className="btn btn-secondary span-1" onClick={clearData}>
          Clear
        </button>

        <div className="form-divider span-6" />

        <select
          id="withdrawMonthInput"
          className="span-2 month-select"
          value={withdrawMonthInput}
          onChange={(event) => setWithdrawMonthInput(event.target.value)}
        >
          <option value="" disabled>
            Withdraw Month
          </option>
          {MONTH_OPTIONS.map((month) => (
            <option key={`withdraw-${month}`} value={month}>
              {month}
            </option>
          ))}
        </select>

        <input
          className="span-1 day-input"
          type="number"
          id="withdrawDayInput"
          min={1}
          max={31}
          placeholder="Day"
          value={withdrawDayInput}
          onChange={(event) => setWithdrawDayInput(event.target.value)}
        />

        <input
          className="span-2"
          type="number"
          id="withdrawInput"
          placeholder="Withdrawal Amount ($)"
          value={withdrawValueInput}
          onChange={(event) => setWithdrawValueInput(event.target.value)}
        />

        <button type="button" className="btn btn-withdraw span-1" onClick={addWithdrawal}>
          Withdraw
        </button>
        <div className="span-1" />
      </div>

      <div className="list" id="dataList" onMouseLeave={() => setActiveChartPoint(null)}>
        {filteredRows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-pill">No entries yet</div>
            <p>Add P&L or withdrawals to populate your timeline.</p>
          </div>
        ) : (
          filteredRows.map(({ entry, index }) => {
            const previousValue = index > 0 ? entries[index - 1].value : entry.value
            const isLoss = !entry.isWithdrawal && index > 0 && entry.value < previousValue
            const badgeText = entry.isWithdrawal ? 'WD' : index === 0 ? 'DEP' : isLoss ? '▼' : '▲'
            const badgeClass = entry.isWithdrawal
              ? 'tag-wd'
              : index === 0
                ? 'tag-dep'
                : isLoss
                  ? 'tag-pl-down'
                  : 'tag-pl'
            const parsedLabel = parseMonthDayLabel(entry.label)
            const dateLabel = parsedLabel ? `${parsedLabel.month} ${parsedLabel.day}` : entry.label
            const delta = index === 0 ? null : entry.value - entries[index - 1].value
            const isDeposit = index === 0
            const deltaLabel = isDeposit
              ? 'Deposit'
              : delta === null
                ? '—'
                : `${delta > 0 ? '+' : ''}${formatMoney(delta, moneyFormatter)}`

            return (
              <div
                key={`${entry.label}-${index}`}
                className={`list-row ${activeIndex === index ? 'list-row-active' : ''}`}
                data-idx={index}
                onMouseEnter={() => setActiveChartPoint(index)}
                onClick={() => {
                  setActiveChartPoint(index)
                  chartRef.current?.canvas.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                }}
              >
                <span className={badgeClass}>{badgeText}</span>
                <span className="entry-text">
                  <span className="entry-amount">{formatMoney(entry.value, moneyFormatter)}</span>
                  <span className="entry-date">{dateLabel}</span>
                </span>
                <span
                  className={`entry-delta ${
                    isDeposit
                      ? 'delta-dep'
                      : entry.isWithdrawal
                        ? 'delta-withdraw'
                        : delta === null
                          ? 'delta-neutral'
                          : delta > 0
                            ? 'delta-up'
                            : 'delta-down'
                  }`}
                >
                  {deltaLabel}
                </span>
              </div>
            )
          })
        )}
      </div>

      <div className="list-footer" id="listFooter">
        <div className="footer-metric">
          <span className="metric-label">Balance</span>
          <span className="metric-value" id="footerBalance">
            {footerBalance}
          </span>
        </div>
        <div className="footer-metric">
          <span className="metric-label">Entries</span>
          <span className="metric-value" id="footerCount">
            {footerEntryCount}
          </span>
        </div>
        <div className="footer-metric">
          <span className="metric-label">Last updated</span>
          <span className="metric-value" id="footerUpdated">
            {footerUpdated}
          </span>
        </div>
      </div>

      {savedFilesOpen ? (
        <div
          className="drawer-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSavedFilesOpen(false)
            }
          }}
        >
          <div className="drawer saved-files-drawer" role="dialog" aria-modal="true" aria-label="Saved files">
            <div className="drawer-header">
              <div>
                <div className="auth-overline">Imports</div>
                <h3>Saved Files</h3>
              </div>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => setSavedFilesOpen(false)}>
                Close
              </button>
            </div>

            <div className="saved-files-summary">
              <span>{savedFiles.length} file(s) saved from imports</span>
              {savedFiles.length > 0 ? (
                <button type="button" className="btn btn-danger btn-small" onClick={() => setSavedFiles([])}>
                  Clear all
                </button>
              ) : null}
            </div>

            <div className="saved-files-list">
              {savedFiles.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-pill">No saved files</div>
                  <p>Import a JSON file and it will appear here automatically.</p>
                </div>
              ) : (
                savedFiles.map((savedFile) => (
                  <div key={savedFile.id} className="saved-file-row">
                    <div className="saved-file-main">
                      <div className="saved-file-name">{savedFile.name}</div>
                      <div className="saved-file-meta">
                        {savedFile.data.months.length} entries · {formatSavedFileDate(savedFile.importedAt)}
                      </div>
                    </div>
                    <div className="saved-file-actions">
                      <button type="button" className="btn btn-primary btn-small" onClick={() => loadSavedFile(savedFile)}>
                        Load
                      </button>
                      <button type="button" className="btn btn-secondary btn-small" onClick={() => renameSavedFile(savedFile)}>
                        Rename
                      </button>
                      <button type="button" className="btn btn-danger btn-small" onClick={() => deleteSavedFile(savedFile.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="session-panel session-bottom">
        <div className="session-meta">
          <span className="live-dot-floating" aria-label="Live indicator" />
          <span className={`panel-strength market-${overallMarketStrength.toLowerCase()}`}>
            {overallMarketStrength}
          </span>
          <div className="session-heading">
            <div className="session-title">Live Trading Sessions</div>
            <div className="session-subtitle">
              Current time · {nowPhtLabel} {settings.timeZone}
            </div>
          </div>
          <span className="session-open-count">
            {openSessions.length > 0 ? `${openSessions.length} open` : 'All closed'}
          </span>
        </div>
        <div className="session-grid session-grid-compact">
          {sessionStatuses.map((session) => (
            <div
              key={session.name}
              className={`session-card ${session.isOpen ? 'session-card-open' : 'session-card-closed'}`}
              style={{ borderColor: session.isOpen ? session.accent : 'rgba(255,255,255,0.08)' }}
            >
              <div className="session-card-top">
                <span className="session-chip" style={{ background: session.accent }}>
                  {session.name}
                </span>
                <span className={session.isOpen ? 'status-pill open' : 'status-pill closed'}>
                  {session.isOpen ? 'OPEN' : 'CLOSED'}
                </span>
              </div>
              <div className="session-timing">
                {session.displayStart} - {session.displayEnd} {DISPLAY_TIMEZONE_LABEL}
              </div>
              <div className="session-next">{session.nextLabel}</div>
            </div>
          ))}
        </div>
      </div>
      <footer className="credits">
        Credits: Janus "Pogi" Ibasco &amp; Mark Gil "Gwapo" Camba
      </footer>
    </div>
  )
}

export default App
