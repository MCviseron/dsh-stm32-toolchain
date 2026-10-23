import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

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

const calls = []
globalThis.window = { __ModuleLoader__: { load: (d) => registry.set(d.id, d) }, addEventListener() {}, removeEventListener() {} }
const registry = new Map()
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init && init.body })
  return { json: async () => ({ ok: true, binding: null }) }
}
globalThis.EventSource = class { constructor() {} addEventListener() {} close() {} }

const mod = (await import(pathToFileURL(join(HERE, '..', 'lib', 'client.js')).href), registry.get('dsh-stm32-toolchain'))
const bundle = mod.factory((name) => { if (name === 'react') return React; throw new Error('require ' + name) })
const registered = []
bundle.apply({
  slots: { inject: (name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => undefined } },
  inject: () => undefined,
})

const panelEntry = registered.find((entry) => entry.spec.name === 'main')
const panel = JSON.stringify(panelEntry.component())
check('an unbound panel says so', panel.includes('未绑定会话'), panel.slice(0, 60))
check('and offers no send button while unbound', panel.includes('"disabled":true') && !panel.includes('发送到此会话'))

const dockEntry = registered.find((entry) => entry.spec.id === 'stm32-toolchain-bind')
check('the session header holds a bind control',
  dockEntry !== undefined && dockEntry.spec.name === 'conversation.session.header.actions',
  dockEntry && dockEntry.spec.name)
if (dockEntry) {
  const injected = typeof dockEntry.spec.inject === 'function' ? dockEntry.spec.inject('session-abc') : {}
  check('the session id is injected by the framework', injected.sessionId === 'session-abc', JSON.stringify(injected))
  const tree = JSON.stringify(dockEntry.component({ sessionId: 'session-abc' }))
  check('unbound shows the bind button', tree.includes('绑定 STM32'), tree.slice(0, 80))
}

const source = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
check('the bound state is labelled for this session', source.includes('"本会话已绑定"'))
check('and for another session', source.includes('"非本会话已绑定"'))
check('binding goes through the bridge', source.includes('write("set-binding"') && source.includes('write("clear-binding"'))
check('sending uses the host ask route', source.includes('API + "/ask"') && source.includes('sessionId: bound.sessionId'))
check('no session is created any more', !source.includes('sessionsService.create'))
check('an empty input jumps through uiWorkspace.openSession',
  source.includes('function jumpToBoundSession()') && source.includes('workspaceService.openSession') && source.includes('"跳转到会话"'))
check('the view is never pinned by a mainView retention', !source.includes('source: "mainView"'))
check('the placeholder explains both behaviours', source.includes('留空＝跳转到该会话；写内容＝发送给它'))
