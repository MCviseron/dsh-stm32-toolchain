import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOpenCommand, resolveOpenPath, resolveProjectRoot, climbBuildDir } from '../lib/core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!condition) process.exitCode = 1
}

const folderCmd = buildOpenCommand({ folder: 'D:\\实验室竞赛\\物流小车\\MK' })
check('a folder opens without -g', JSON.stringify(folderCmd.args) === JSON.stringify(['/d', '/s', '/c', 'code', 'D:\\实验室竞赛\\物流小车\\MK']), JSON.stringify(folderCmd.args))
check('the folder argument carries no hand-written quotes',
  folderCmd.args.every((arg) => !arg.includes('"')), JSON.stringify(folderCmd.args))

const lineCmd = buildOpenCommand({ file: 'D:\\a b\\main.c', line: 12 })
check('a file opens at its line', JSON.stringify(lineCmd.args) === JSON.stringify(['/d', '/s', '/c', 'code', '-g', 'D:\\a b\\main.c:12']), JSON.stringify(lineCmd.args))

let threw = false
try { buildOpenCommand({}) } catch { threw = true }
check('an empty target is refused', threw)

check('a relative build path is resolved against the project',
  resolveOpenPath('..\\Src\\main.c', 'D:\\proj\\MDK-ARM\\app.uvprojx') === 'D:\\proj\\Src\\main.c',
  resolveOpenPath('..\\Src\\main.c', 'D:\\proj\\MDK-ARM\\app.uvprojx'))
check('an absolute path is left alone',
  resolveOpenPath('D:\\x\\y.c', 'D:\\proj\\a.uvprojx') === 'D:\\x\\y.c')
check('a UNC path is left alone', resolveOpenPath('\\\\server\\share\\y.c', 'D:\\proj\\a.uvprojx') === '\\\\server\\share\\y.c')

const realProject = 'D:\\实验室竞赛\\物流小车\\2026-Engineering-Training\\Code\\Stm32\\2026-Logistics - Back\\MDK-ARM\\2026-Logistics.uvprojx'
check('MDK-ARM is not treated as the project root',
  resolveProjectRoot(realProject) === 'D:\\实验室竞赛\\物流小车\\2026-Engineering-Training\\Code\\Stm32\\2026-Logistics - Back',
  resolveProjectRoot(realProject))
check('a project outside a build dir keeps its own folder',
  resolveProjectRoot('D:\\solo\\app.uvprojx') === 'D:\\solo')
check('nested build dirs climb out of both',
  resolveProjectRoot('D:\\p\\MDK-ARM\\Objects\\app.uvprojx') === 'D:\\p', resolveProjectRoot('D:\\p\\MDK-ARM\\Objects\\app.uvprojx'))
check('climbBuildDir works on a bare folder too', climbBuildDir('D:\\p\\MDK-ARM') === 'D:\\p')

const client = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
check('the VSCode button hands the project over',
  client.includes('title: "在 VS Code 中打开工程文件夹"') && client.includes('run("open-vscode", { project: state.project })'))

const bridge = readFileSync(join(HERE, '..', 'lib', 'bridge.mjs'), 'utf8')
check('the bridge resolves the project root before opening',
  bridge.includes('resolveOpenPath(params.file, projectFile)') &&
  bridge.includes('if (params.project) return await openInVscode({ folder: resolveProjectRoot(params.project) })') &&
  bridge.includes('folder: climbBuildDir(params.folder)'))
check('a missing file is refused instead of opening an empty buffer',
  bridge.includes('if (!existsSync(file))') && bridge.includes('不会为你打开一个空文件'))
