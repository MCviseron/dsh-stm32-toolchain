import { makeRoutes, makeSettingsRoutes, pickPresentation, readConfigValue, unwrapConfig } from '../lib/index.js'

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

function fakeRes() {
  const captured = { status: 0, headers: null, body: '' }
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(body) { captured.body = body },
  }
}

function reqFrom(json) {
  const body = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
  return { async *[Symbol.asyncIterator]() { for (const chunk of body) yield chunk } }
}

const presented = pickPresentation({ logFontSize: '15', logLineHeight: '1.8', logColorSerial: '#ff0000', cardOrder: 'logs,chip', logWrap: false, logBgGradient: true })
check('the host projects presentation settings', presented.logFontSize === 15 && presented.logLineHeight === 1.8, JSON.stringify({ f: presented.logFontSize, l: presented.logLineHeight }))
check('colours and order survive the projection', presented.logColorSerial === '#ff0000' && presented.cardOrder === 'logs,chip')
check('booleans keep their meaning', presented.logWrap === false && presented.logBgGradient === true)
check('missing fields fall back to defaults', pickPresentation({}).logFontSize === 12 && pickPresentation({}).cardOrder.split(',').length === 8)

// Reproduce the DSH >= 0.2 shape: volatile fields arrive as live references.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const live = (current) => Object.freeze({ get: () => current, [VOLATILE_WRITE]: () => undefined })

check('a live reference resolves to its value', readConfigValue(live(18)) === 18 && readConfigValue('plain') === 'plain')
check('unwrapConfig resolves every field', unwrapConfig({ a: live(1), b: 'x' }).a === 1)

const fromLive = pickPresentation({
  logFontSize: live(18),
  logLineHeight: live(1.9),
  logMaxLines: live(900),
  cardOrder: live('logs,chip'),
  logColorSerial: live('#ff0000'),
  logWrap: live(false),
  logTimestamps: live(true),
  logBgGradient: live(true),
  logBgFrom: live('#101010'),
})
check('presentation settings survive volatile references',
  fromLive.logFontSize === 18 && fromLive.logLineHeight === 1.9 && fromLive.logMaxLines === 900,
  JSON.stringify({ f: fromLive.logFontSize, l: fromLive.logLineHeight, m: fromLive.logMaxLines }))
check('strings and booleans survive them too',
  fromLive.cardOrder === 'logs,chip' && fromLive.logColorSerial === '#ff0000' &&
  fromLive.logWrap === false && fromLive.logTimestamps === true && fromLive.logBgGradient === true && fromLive.logBgFrom === '#101010',
  JSON.stringify({ order: fromLive.cardOrder, serial: fromLive.logColorSerial, wrap: fromLive.logWrap }))

const launchFromLive = unwrapConfig({ project: live('D:/p/Project.uvprojx'), transport: live('uart') })
check('the launch config sees plain values as well',
  launchFromLive.project === 'D:/p/Project.uvprojx' && launchFromLive.transport === 'uart')

// /config must answer with whatever the live getter returns (settings service),
// not with the apply-time snapshot.
const liveFromSettings = pickPresentation(unwrapConfig({ logFontSize: live(18), cardOrder: live('logs,chip') }))
const configRoutes = makeRoutes(() => 1, () => liveFromSettings)
const configRoute = configRoutes.find((route) => route.path.endsWith('/config'))
const configRes = fakeRes()
await configRoute.handler(reqFrom(), configRes)
const served = JSON.parse(configRes.captured.body)
check('GET /config serves the live presentation config', served.config.logFontSize === 18 && served.config.cardOrder === 'logs,chip', JSON.stringify(served.config).slice(0, 90))

const calls = []
const settings = {
  writable: true,
  describe: () => [
    { ns: 'some-other-plugin', value: { x: 1 }, revision: 1 },
    { ns: 'stm32-toolchain', value: { uv4Path: '', baud: 115200 }, base: {}, user: {}, revision: 7, secrets: [] },
  ],
  mutate: async (ns, ops, revision) => {
    calls.push({ ns, ops, revision })
    if (ns !== 'stm32-toolchain') throw Object.assign(new Error('wrong namespace'), { code: 'BAD_NS' })
  },
}

const routes = makeSettingsRoutes(settings)
const describeRoute = routes.find((r) => r.path.endsWith('/settings/describe'))
const mutateRoute = routes.find((r) => r.path.endsWith('/settings/mutate'))

const res1 = fakeRes()
await describeRoute.handler(reqFrom(), res1)
const described = JSON.parse(res1.captured.body)
check('describe returns only this plugin namespace', described.namespaces.length === 1 && described.namespaces[0].ns === 'stm32-toolchain', JSON.stringify(described.namespaces.map((n) => n.ns)))
check('describe reports writable', described.writable === true)
check('describe exposes the revision', described.namespaces[0].revision === 7)

const res2 = fakeRes()
await mutateRoute.handler(reqFrom({ revision: 7, ops: [{ op: 'set', path: ['uv4Path'], value: 'D:/x/UV4.exe' }] }), res2)
const mutated = JSON.parse(res2.captured.body)
check('mutate writes only stm32-toolchain', calls.length === 1 && calls[0].ns === 'stm32-toolchain', JSON.stringify(calls[0]))
check('mutate forwards ops and revision', calls[0].revision === 7 && calls[0].ops[0].path[0] === 'uv4Path')
check('mutate answers ok with the fresh namespace', mutated.ok === true && mutated.namespace.revision === 7)

settings.mutate = async () => { throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' }) }
const res3 = fakeRes()
await mutateRoute.handler(reqFrom({ revision: 6, ops: [] }), res3)
const conflicted = JSON.parse(res3.captured.body)
check('mutate surfaces a conflict instead of throwing', conflicted.ok === false && conflicted.code === 'SETTINGS_CONFLICT', JSON.stringify(conflicted))
