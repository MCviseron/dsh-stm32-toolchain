import { createRequire } from 'node:module'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

// Minimal React stand-in: enough to run one render pass and catch crashes,
// provider wiring mistakes and hook-order surprises in the panel.
function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return { type, props: Object.assign({}, props, { children: children.length === 1 ? children[0] : children }) }
}
const React = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
  useEffect: () => undefined,
  useRef: (value) => ({ current: value }),
}

const registry = new Map()
globalThis.window = { __ModuleLoader__: { load: (definition) => { registry.set(definition.id, definition) } } }
globalThis.fetch = async () => ({ json: async () => ({}) })
globalThis.EventSource = class { constructor() {} addEventListener() {} close() {} }

const requireShim = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

await import(pathToFileURL(join(HERE, '..', 'lib', 'client.js')).href)

const definition = registry.get('dsh-stm32-toolchain')
check('bundle registers under its package id', definition !== undefined)
const mod = definition.factory(requireShim)
check('bundle exports apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject), JSON.stringify(mod.inject))

const registered = []
const ctx = { slots: { inject: (name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => undefined } } }
mod.apply(ctx)

const names = registered.map((entry) => entry.spec.name)
check('registers the sidebar entry', names.includes('sidebar.panellist'), names.join(','))
check('registers the main panel', names.includes('main'), names.join(','))

const panel = registered.find((entry) => entry.spec.name === 'main')
const tree = panel.component()
const flat = JSON.stringify(tree)
check('panel renders without throwing', typeof tree === 'object' && tree !== null)
check('panel shows the title', flat.includes('STM32'), flat.slice(0, 80))
check('panel shows the action bar', flat.includes('一键编译'), '')
check('panel shows the stat cards', flat.includes('芯片') && flat.includes('固件') && flat.includes('烧录'))

function countGrids(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 60) return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countGrids(child, depth + 1), 0)
  if (typeof node.type === 'function') return countGrids(node.type(node.props), depth + 1)
  // Only the card rows use auto-fit columns; the body layout is a fixed 2-column grid.
  const style = (node.props && node.props.style) || {}
  const own = style.display === 'grid' && String(style.gridTemplateColumns || '').includes('auto-fit') ? 1 : 0
  return own + countGrids(node.props && node.props.children, depth + 1)
}
check('stat cards sit on two rows', countGrids(tree) === 2, 'grids=' + countGrids(tree))

/** Labels of the cards directly inside one card row. */
function cardLabels(children) {
  return (Array.isArray(children) ? children : [children])
    .filter((child) => child && typeof child === 'object' && child.props && typeof child.props.label === 'string' && 'value' in child.props)
    .map((child) => child.props.label)
}

function cardRows(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object' || depth > 60) return out
  if (Array.isArray(node)) { node.forEach((child) => cardRows(child, depth + 1, out)); return out }
  if (typeof node.type === 'function') return cardRows(node.type(node.props), depth + 1, out)
  const style = (node.props && node.props.style) || {}
  if (style.display === 'grid' && String(style.gridTemplateColumns || '').includes('auto-fit')) out.push(cardLabels(node.props.children))
  return cardRows(node.props && node.props.children, depth + 1, out)
}

const internals = mod.__internals
check('bundle exports the order helper', internals && typeof internals.resolveOrder === 'function')

const custom = internals.resolveOrder('logs,lease,build,flash,chip,transport,port,firmware')
check('a custom order is honoured', custom[0] === 'logs' && custom[7] === 'firmware', custom.join(','))
check('unknown and duplicate ids are dropped',
  JSON.stringify(internals.resolveOrder('logs,logs,bogus,chip')) === JSON.stringify(['logs', 'chip', 'transport', 'port', 'firmware', 'build', 'flash', 'lease']),
  JSON.stringify(internals.resolveOrder('logs,logs,bogus,chip')))
check('an empty order falls back to the default', internals.resolveOrder('').length === 8 && internals.resolveOrder('')[0] === 'chip')
check('dragging moves a slot, it does not swap',
  JSON.stringify(internals.moveCard(['a', 'b', 'c', 'd'], 0, 2)) === JSON.stringify(['b', 'c', 'a', 'd']) &&
  JSON.stringify(internals.moveCard(['a', 'b', 'c', 'd'], 3, 1)) === JSON.stringify(['a', 'd', 'b', 'c']),
  JSON.stringify(internals.moveCard(['a', 'b', 'c', 'd'], 0, 2)))
check('out-of-range drags are ignored',
  JSON.stringify(internals.moveCard(['a', 'b'], 0, 9)) === JSON.stringify(['a', 'b']))
const rawDefaults = internals.logPrefs(undefined)
check('log defaults match the host schema',
  rawDefaults.fontSize === 12 && rawDefaults.lineHeight === 1.5 && rawDefaults.maxLines === 400 &&
  rawDefaults.wrap === true && rawDefaults.timestamps === false,
  JSON.stringify({ f: rawDefaults.fontSize, l: rawDefaults.lineHeight, m: rawDefaults.maxLines }))
const prefDefaults = internals.logPrefs(undefined)
check('colours and gradient default to "theme default"',
  prefDefaults.colors.build === '' && prefDefaults.gradient.enabled === false && prefDefaults.gradient.from === '#0d1117',
  JSON.stringify(prefDefaults.gradient))
check('an empty colour falls back to the channel colour',
  internals.lineColor(prefDefaults, 'serial') === '#5aa9ff', internals.lineColor(prefDefaults, 'serial'))
const hostWins = internals.resolveLook({ logFontSize: 18 }, { logFontSize: 12 })
check('the host config beats the bridge snapshot', hostWins.logFontSize === 18, JSON.stringify(hostWins))
check('the bridge snapshot is the first-paint fallback', internals.resolveLook(null, { logFontSize: 12 }).logFontSize === 12)
check('nothing in, empty object out', JSON.stringify(internals.resolveLook(undefined, undefined)) === '{}')

// A save must never wipe fields the form no longer holds (that reset colours).
const opsLost = internals.buildOps({ logFontSize: 18 })
check('colours the form lost are left alone', !opsLost.some((op) => String(op.path[0]).startsWith('logColor')), JSON.stringify(opsLost.map((op) => op.path[0])))
const opsBlank = internals.buildOps({ logFontSize: '', logColorSerial: '' })
check('blank numbers are skipped, not written as 0', !opsBlank.some((op) => op.path[0] === 'logFontSize'), JSON.stringify(opsBlank.find((op) => op.path[0] === 'logFontSize')))
const opsColors = internals.buildOps({ logColorSerial: '#ff0000', logFontSize: '18' })
check('the values the form does hold are written',
  opsColors.some((op) => op.path[0] === 'logColorSerial' && op.value === '#ff0000') &&
  opsColors.some((op) => op.path[0] === 'logFontSize' && op.value === 18))
check('card order is always written', opsColors.some((op) => op.path[0] === 'cardOrder'))
check('the response merge keeps colour keys it omits',
  internals.mergeForm({ logColorSerial: '#ff0000' }, { logFontSize: 18 }).logColorSerial === '#ff0000' &&
  internals.mergeForm({ logColorSerial: '#ff0000' }, { logFontSize: 18 }).logFontSize === 18)

check('a custom colour wins',
  internals.lineColor(internals.logPrefs({ logColorSerial: '#ff8800' }), 'serial') === '#ff8800')
check('the gradient drives the panel background',
  internals.logBackground(prefDefaults) === 'rgba(127,127,127,0.10)' &&
  internals.logBackground(internals.logPrefs({ logBgGradient: true, logBgFrom: '#101010', logBgTo: '#303030' })) === 'linear-gradient(135deg, #101010, #303030)',
  internals.logBackground(internals.logPrefs({ logBgGradient: true })))
check('the sample covers every channel',
  ['build', 'flash', 'serial', 'sys'].every((channel) => internals.LOG_SAMPLES.some((sample) => sample.channel === channel)))

check('log prefs read the settings',
  internals.logPrefs({ logFontSize: 15, logLineHeight: 1.8, logMaxLines: 900, logWrap: false, logTimestamps: true }).timestamps === true &&
  internals.logPrefs({ logMaxLines: 900 }).maxLines === 900)

const bundle = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
check('the ordering bar is a drag list with a ≡ handle',
  bundle.includes('状态卡排序') && bundle.includes('onDragStart') && bundle.includes('draggable: writable') && bundle.includes('≡') && bundle.includes('按住右侧'))
check('the old arrow/dropdown reordering is gone', !bundle.includes('swapOrder') && !bundle.includes('moveOrder'))
// The only repeat(2, …) grid is the colour pickers; the ordering list is a flex column.
check('the ordering list is one column, not two',
  bundle.includes('flexDirection: "column", gap: "6px"') && (bundle.split('repeat(2, minmax').length - 1) === 1,
  'repeat2=' + (bundle.split('repeat(2, minmax').length - 1))
// Compare positions inside the settings card's render block, not in the module.
const renderStart = bundle.indexOf('h("div", { style: card },')
const iEnabled = bundle.indexOf('settingsRow("enabled"', renderStart)
const iAnnounce = bundle.indexOf('settingsRow("announce"', renderStart)
const iFields = bundle.indexOf('FIELDS.map(function (field)', renderStart)
const iSave = bundle.indexOf('onClick: save', renderStart)
check('the two switches sit above the toolchain fields',
  renderStart > 0 && iEnabled > renderStart && iEnabled < iAnnounce && iAnnounce < iFields && iFields < iSave,
  'render@' + renderStart + ' enabled@' + iEnabled + ' announce@' + iAnnounce + ' fields@' + iFields + ' save@' + iSave)
// 1 declaration + 4 static rows + 2 mapped lists (FIELDS, LOG_FIELDS).
const rowCount = bundle.split('settingsRow(').length - 1
const mappedRows = bundle.split('return settingsRow(').length - 1
check('settings items render through one row helper', rowCount >= 6 && mappedRows === 2, 'sites=' + rowCount + ' mapped=' + mappedRows)
check('rows are separated by a hairline divider',
  bundle.includes('borderBottom: SETTINGS_DIVIDER') && bundle.includes('var(--dsw-alias-border-l'))
const groups = ['常规', '工具链', '日志文字', '状态卡排序'].filter((title) => bundle.includes('settingsGroup(') && bundle.includes('"' + title + '"'))
check('the gradient is scoped to the log text, not the tab bar',
  bundle.includes('background: logBackground(prefs)') && bundle.includes('style: S.logCard }'))
// Official pattern: one client store, written by the settings card, read by the panel.
check('the settings card writes the shared look store',
  bundle.includes('lookStore.set(presentationFromForm(merged))'))
check('the panel subscribes to it',
  bundle.includes('lookStore.subscribe(function (next) { setLiveLook(next); })'))

const store = internals.lookStore
let heard = null
const off = store.subscribe((next) => { heard = next })
store.set({ logFontSize: 18 })
check('the store notifies subscribers immediately', heard !== null && heard.logFontSize === 18 && store.get().logFontSize === 18, JSON.stringify(heard))
off()
store.set({ logFontSize: 20 })
check('unsubscribing stops the notifications', heard.logFontSize === 18, JSON.stringify(heard))
check('a new bridge instance resets the log stream',
  bundle.includes('var seenInstance = React.useRef(null)') &&
  bundle.includes('entry.instance !== seenInstance.current') &&
  bundle.includes('seenInstance.current = entry.instance;') &&
  bundle.includes('setLogs([]);'))
check('log keys are unique across instances',
  bundle.includes('key: (entry.instance || "") + ":" + entry.seq'))
check('clearing is a two-item menu',
  bundle.includes('label: "清空日志"') &&
  bundle.includes('{ id: "current", label: "清空当前日志" }') &&
  bundle.includes('{ id: "all", label: "清空所有日志" }'))
check('"清空当前日志" respects the selected tab',
  bundle.includes('entry.channel !== channel') && bundle.includes('run("clear-logs", { channel: channel })'))
check('"全部" means clear everything',
  bundle.includes('if (id === "all" || channel === "")') && bundle.includes('run("clear-logs");'))
check('saving pushes the toolchain paths to the bridge',
  bundle.includes('post("set-tools"') && bundle.includes('uv4Path: String(merged.uv4Path'))
check('settings that need a host reload say so',
  bundle.includes('改动后需重启 DSH 才生效') && bundle.includes('开关需要宿主重载插件') && (bundle.split('restart: true').length - 1) === 2)
check('the panel prefers the app native directory picker',
  bundle.includes('__DSH_DIRECTORY_PICKER__') && bundle.includes('uiWorkspace') && bundle.includes('pickDirectory'))
check('and still falls back to the bridge picker',
  bundle.includes('if (directoryPicker)') && bundle.includes('run("pick-folder")'))
check('the panel resyncs presentation config from the host',
  bundle.includes('API + "/config"') && bundle.includes('if (alive) resync(); }, 2000)') && bundle.includes('source.onopen'),
  'has /config: ' + bundle.includes('API + "/config"'))
const allGroups = ['常规', '工具链', '日志文字', '日志颜色', '状态卡排序'].filter((title) => bundle.includes('"' + title + '"'))
check('the settings categories are kept', allGroups.length === 5, allGroups.join(','))
check('the log preview renders from the edited values',
  bundle.includes('"日志预览"') && bundle.includes('h(LogSample, { prefs: logPrefs(value) })'))
const iPreview = bundle.indexOf('"日志预览"', renderStart)
const iOrderGroup = bundle.indexOf('"状态卡排序"', renderStart)
const iSaveRow = bundle.indexOf('onClick: save', renderStart)
check('the preview sits right under the log settings, not at the bottom',
  iPreview > renderStart && iPreview < iOrderGroup && iOrderGroup < iSaveRow,
  'preview@' + iPreview + ' order@' + iOrderGroup + ' save@' + iSaveRow)
const colorInputs = bundle.split('type: "color"').length - 1
check('colour inputs and the gradient switch exist',
  colorInputs === 1 && bundle.includes('"背景渐变"') && bundle.includes('logBgGradient'), 'inputs=' + colorInputs)
check('the six colour pickers fold into two columns',
  bundle.includes('gridTemplateColumns: "repeat(2, minmax(0, 1fr))"') && bundle.includes('LOG_COLOR_FIELDS.map(function (field)'))
check('settings card exposes the log text fields',
  ['logFontSize', 'logLineHeight', 'logMaxLines', 'logWrap', 'logTimestamps'].every((key) => bundle.includes('"' + key + '"')))

const rows = cardRows(tree)
check('each row holds four cards', rows.length === 2 && rows[0].length === 4 && rows[1].length === 4, JSON.stringify(rows))
check('row 1 is identity, row 2 is activity',
  JSON.stringify(rows[0]) === JSON.stringify(['芯片', '传输', '端口', '固件']) &&
  JSON.stringify(rows[1]) === JSON.stringify(['编译', '烧录', '占用', '日志']),
  JSON.stringify(rows))
