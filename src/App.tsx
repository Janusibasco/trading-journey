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

type LineChart = Chart<'line', (number | null)[], string>

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

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function formatMoney(value: number): string {
  return moneyFormatter.format(value)
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

function buildExportData(entries: Entry[]): {
  months: string[]
  values: number[]
  withdrawalIndexes: number[]
} {
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

function App() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const [monthInput, setMonthInput] = useState('')
  const [dayInput, setDayInput] = useState('')
  const [valueInput, setValueInput] = useState('')

  const [withdrawMonthInput, setWithdrawMonthInput] = useState('')
  const [withdrawDayInput, setWithdrawDayInput] = useState('')
  const [withdrawValueInput, setWithdrawValueInput] = useState('')

  const [chartError, setChartError] = useState('')

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<LineChart | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const rafHandleRef = useRef<number | null>(null)
  const entriesRef = useRef<Entry[]>([])
  entriesRef.current = entries

  const queueChartUpdate = useCallback(() => {
    if (rafHandleRef.current !== null) {
      return
    }

    rafHandleRef.current = window.requestAnimationFrame(() => {
      chartRef.current?.update()
      rafHandleRef.current = null
    })
  }, [])

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

        setEntries(loadedEntries)

        const latestLabel = loadedEntries[loadedEntries.length - 1]?.label
        const parsed = latestLabel ? parseMonthDayLabel(latestLabel) : null
        if (parsed) {
          applyDateFields(parsed.month, parsed.day)
        } else {
          setDateFieldsToToday()
        }
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
  }, [applyDateFields, setDateFieldsToToday])

  useEffect(() => {
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
            label: 'Daily Amount (USD)',
            data: [],
            borderColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: '#3ecbff' },
                { stop: 0.45, color: '#2ab5ff' },
                { stop: 1, color: '#0b9bff' },
              ]),
            backgroundColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: 'rgba(62, 203, 255, 0.32)' },
                { stop: 0.45, color: 'rgba(42, 181, 255, 0.26)' },
                { stop: 1, color: 'rgba(11, 155, 255, 0.24)' },
              ]),
            borderWidth: 3,
            tension: 0.2,
            cubicInterpolationMode: 'monotone',
            pointRadius: 3,
            pointHoverRadius: 5,
            pointBorderWidth: 2,
            pointBackgroundColor: (context: ScriptableContext<'line'>) => {
              const index = context.dataIndex
              const data = context.dataset.data as number[]
              if (entriesRef.current[index]?.isWithdrawal) {
                return '#2ed17a'
              }
              if (index === 0) {
                return '#3ecbff'
              }
              return data[index] < data[index - 1] ? '#ff6b6b' : '#3ecbff'
            },
            pointBorderColor: (context: ScriptableContext<'line'>) => {
              const index = context.dataIndex
              const data = context.dataset.data as number[]
              if (entriesRef.current[index]?.isWithdrawal) {
                return '#2ed17a'
              }
              if (index === 0) {
                return '#3ecbff'
              }
              return data[index] < data[index - 1] ? '#ff6b6b' : '#3ecbff'
            },
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
                  return 'rgba(34, 197, 94, 0.24)'
                }
                return current < previous
                  ? 'rgba(255, 95, 109, 0.26)'
                  : 'rgba(56, 189, 248, 0.24)'
              },
            },
          },
          {
            label: 'Withdrawal',
            data: [],
            borderColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: '#3ae374' },
                { stop: 1, color: '#16c75f' },
              ]),
            backgroundColor: (context: ScriptableContext<'line'>) =>
              getLineGradient(context, [
                { stop: 0, color: 'rgba(58, 227, 116, 0.26)' },
                { stop: 1, color: 'rgba(22, 199, 95, 0.22)' },
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
        interaction: {
          intersect: false,
          mode: 'nearest',
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: 'rgba(255,255,255,0.06)',
            },
            ticks: {
              callback(value) {
                return formatMoney(Number(value))
              },
            },
          },
        },
        plugins: {
          legend: {
            labels: {
              color: '#dfe8ff',
            },
          },
          tooltip: {
            callbacks: {
              label(context: TooltipItem<'line'>) {
                const index = context.dataIndex
                const data = context.dataset.data as number[]
                const current = Number(data[index])
                const priceLine = `Price: ${formatMoney(current)}`

                if (index === 0) {
                  return priceLine
                }

                const previous = Number(data[index - 1])
                const difference = current - previous
                const percent =
                  previous === 0 ? 0 : ((difference / previous) * 100)
                const change = formatMoney(Math.abs(difference))

                if (difference > 0) {
                  return [
                    priceLine,
                    `Increase: +${change} (+${percent.toFixed(2)}%)`,
                  ]
                }

                if (difference < 0) {
                  if (entriesRef.current[index]?.isWithdrawal) {
                    return [
                      priceLine,
                      `Withdrawal: -${change} (${percent.toFixed(2)}%)`,
                    ]
                  }
                  return [
                    priceLine,
                    `Decrease: -${change} (${percent.toFixed(2)}%)`,
                  ]
                }

                return `${priceLine} (No Change)`
              },
              labelTextColor(context: TooltipItem<'line'>) {
                const index = context.dataIndex
                const data = context.dataset.data as number[]
                if (index > 0 && data[index] < data[index - 1]) {
                  return entriesRef.current[index]?.isWithdrawal
                    ? '#34d399'
                    : '#f87171'
                }
                return '#22d3ee'
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
    setChartError('')

    return () => {
      chart.destroy()
      chartRef.current = null
      if (rafHandleRef.current !== null) {
        window.cancelAnimationFrame(rafHandleRef.current)
        rafHandleRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) {
      return
    }

    chart.data.labels = entries.map((entry) => entry.label)
    chart.data.datasets[0].data = entries.map((entry) => entry.value)
    chart.data.datasets[1].data = entries.map((entry) =>
      entry.isWithdrawal ? entry.value : null,
    )

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

          setEntries(importedEntries)

          const latestLabel = importedEntries[importedEntries.length - 1]?.label
          const parsedDate = latestLabel ? parseMonthDayLabel(latestLabel) : null
          if (parsedDate) {
            applyDateFields(parsedDate.month, parsedDate.day)
          } else {
            setDateFieldsToToday()
          }
        } catch {
          window.alert('Error reading JSON file.')
        }
      }

      reader.readAsText(file)
      event.target.value = ''
    },
    [applyDateFields, setDateFieldsToToday],
  )

  const openImportFileDialog = useCallback(() => {
    fileInputRef.current?.click()
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
    entries.length > 0 ? formatMoney(entries[entries.length - 1].value) : '--'
  const footerUpdated = entries.length > 0 ? entries[entries.length - 1].label : '--'

  return (
    <div className="container">
      <div className="header">
        <h2>Profit Linechart</h2>
        <div className="header-actions">
          <button type="button" className="btn btn-accent" onClick={exportJson}>
            Export JSON
          </button>
          <button type="button" className="btn btn-secondary" onClick={openImportFileDialog}>
            Import JSON
          </button>
          <button type="button" className="btn btn-primary capture-btn" onClick={captureChart}>
            Capture
          </button>
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

      <canvas ref={canvasRef} />
      {chartError ? <p className="chart-error">{chartError}</p> : null}

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

      <div className="legend">
        <span className="badge badge-up">Gain</span>
        <span className="badge badge-down">Loss</span>
        <span className="badge badge-wd">Withdrawal</span>
      </div>

      <div className="controls">
        <select
          id="monthInput"
          className="span-2"
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
          className="span-1"
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
          placeholder="Enter Amount ($)"
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
          className="span-2"
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
          className="span-1"
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

        <button type="button" className="btn btn-primary span-1" onClick={addWithdrawal}>
          Withdraw
        </button>
        <div className="span-1" />
      </div>

      <div className="list" id="dataList" onMouseLeave={() => setActiveChartPoint(null)}>
        {filteredRows.map(({ entry, index }) => {
          const previousValue = index > 0 ? entries[index - 1].value : entry.value
          const isLoss = !entry.isWithdrawal && index > 0 && entry.value < previousValue
          const badgeText = entry.isWithdrawal ? 'WD' : isLoss ? 'DOWN' : 'UP'
          const badgeClass = entry.isWithdrawal
            ? 'tag-wd'
            : isLoss
              ? 'tag-pl-down'
              : 'tag-pl'

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
                {entry.label}: {formatMoney(entry.value)}
              </span>
              <span className="entry-balance">Bal: {formatMoney(entry.value)}</span>
            </div>
          )
        })}
      </div>

      <div className="list-footer" id="listFooter">
        <span id="footerBalance">Balance: {footerBalance}</span>
        <span id="footerCount">Entries: {filteredRows.length}</span>
        <span id="footerUpdated">Last updated: {footerUpdated}</span>
      </div>

      <footer className="credits">
        Credits: Janus "Pogi" Ibasco &amp; Mark Gil "Gwapo" Camba
      </footer>
    </div>
  )
}

export default App
