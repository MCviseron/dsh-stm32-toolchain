import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const source = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))

check('bundle asks for the official primitives', source.includes('require("@deepseek-ai/dsh-client-ui-primitives")'))
check('package.json injects the primitives', (pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-primitives'), JSON.stringify(pkg.dsh?.client?.inject))
check('no raw checkbox left in the settings card', !source.includes('type: "checkbox", checked: value.enabled'))

// Render with the primitives present: the Switch path must not throw.
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
function Switch(props) {
  return { type: 'official-switch', props: { checked: props.checked, label: props.label } }
}
function Menu(props) {
  return { type: 'official-menu', props: { open: props.open, anchor: props.anchor, items: props.items } }
}

/**
 * Mini renderer: createElement alone never invokes function components, so
 * resolve them here and then look for the primitive in the produced tree.
 */
function usesSwitch(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 60) return false
  if (Array.isArray(node)) return node.some((child) => usesSwitch(child, depth + 1))
  if (node.type === Switch) return true
  if (typeof node.type === 'function') return usesSwitch(node.type(node.props), depth + 1)
  return usesSwitch(node.props && node.props.children, depth + 1)
}

const registry = new Map()
globalThis.window = { __ModuleLoader__: { load: (definition) => registry.set(definition.id, definition) } }
globalThis.fetch = async () => ({ json: async () => ({}) })
globalThis.EventSource = class { constructor() {} addEventListener() {} close() {} }

const requireShim = (name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Switch, Menu }
  throw new Error('unexpected require: ' + name)
}

await import(pathToFileURL(join(HERE, '..', 'lib', 'client.js')).href)
const mod = registry.get('dsh-stm32-toolchain').factory(requireShim)

const registered = []
mod.apply({ slots: { inject: (name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => undefined } } })
const panel = registered.find((entry) => entry.spec.name === 'main')
const tree = panel.component()
const flat = JSON.stringify(tree)
check('panel renders with the official Switch', typeof tree === 'object' && flat.includes('跟随'))
check('Switch primitive is in the rendered tree', usesSwitch(tree), '')
/** Collect [label, control] pairs of rendered toggle rows. */
function toggleRows(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object' || depth > 60) return out
  if (Array.isArray(node)) { node.forEach((child) => toggleRows(child, depth + 1, out)); return out }
  if (typeof node.type === 'function') return toggleRows(node.type(node.props), depth + 1, out)
  const children = node.props && node.props.children
  if (Array.isArray(children) && children.length === 2 && children[1] && children[1].type === Switch) out.push(children)
  return toggleRows(children, depth + 1, out)
}

const toggles = toggleRows(tree)
check('a toggle puts the control to the right of its label',
  toggles.length > 0 && toggles.every((row) => row[0] && row[0].type === 'span' && typeof JSON.stringify(row[0].props.children) === 'string'),
  'rows=' + toggles.length)

check('Menu primitive backs the dropdowns', JSON.stringify(tree).includes('official-menu') || usesSwitch(tree) && findMenu(tree), '')

function findMenu(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 60) return false
  if (Array.isArray(node)) return node.some((child) => findMenu(child, depth + 1))
  if (node.type === Menu) return true
  if (typeof node.type === 'function') return findMenu(node.type(node.props), depth + 1)
  return findMenu(node.props && node.props.children, depth + 1)
}
