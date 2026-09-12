/**
 * Prose hygiene for the documentation, run by a maintainer rather than by the
 * test suite.
 *
 * The three READMEs are the shop window, and they are written by an assistant,
 * which makes two failures possible that no unit test can see: invisible
 * characters and chat-copy artefacts that arrive with a paste, and facts that
 * quietly change while a paragraph is rewritten. `humanizer-ru` covers both with
 * published false-positive measurements, so this script is a thin wrapper, not a
 * second opinion:
 *
 *   humanizer-markers   artefacts (paste leftovers). Class A is a hard gate —
 *                       its published false-positive rate is zero — while class B
 *                       (zero-width marks, exotic spaces) is printed, because its
 *                       rate is small but not zero and a counter should not
 *                       decide a document
 *   humanizer-facts     diff against the last released text. A lost protected
 *                       term fails; any other lost number or quotation is
 *                       printed for a human to judge, because a version bump
 *                       legitimately changes numbers
 *   humanizer-scan      soft style signs. Never fatal: the tool itself refuses
 *                       to call them evidence, and a counter should not decide
 *                       prose
 *
 * It is deliberately not part of `npm test`: the suite must run for anyone who
 * installs the package, and a Python tool is not a dependency of a Node plugin.
 *
 *   uv tool install humanizer-ru
 *   npm run prose
 *   npm run prose -- --strict   # fail when the tool is missing, for CI
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = ['README.md', 'README.ru.md', 'README.zh.md', 'README.i18n.yaml', 'cordis.patch.yml', 'submission/awesome-dsh-plugin/PLAN.md']
const READMES = ['README.md', 'README.ru.md', 'README.zh.md']
const TERMS = join('scripts', 'prose-terms.txt')
const strict = process.argv.includes('--strict')

const problems = []

/** Run one tool from the project root; `missing` marks an absent executable. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined && result.error.code === 'ENOENT') return { missing: true }
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

function show(title, output) {
  console.log(`\n${title}`)
  for (const line of output.split('\n').filter((entry) => entry.trim() !== '')) console.log(`  ${line}`)
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout : null
}

// Only files that are here: the tool treats a missing path as an error, and a
// maintainer script must not report "artefacts found" when it merely misread its
// own argument list. The package tarball ships the READMEs but not submission/.
const present = DOCS.filter((file) => existsSync(join(root, file)))
const absent = DOCS.filter((file) => present.includes(file) === false)

const probe = run('humanizer-markers', ['--class', 'a', ...present])
if (probe.missing === true) {
  console.log('humanizer-ru is not installed.')
  console.log('  uv tool install humanizer-ru   # then: npm run prose')
  if (strict) process.exit(1)
  process.exit(0)
}
if (absent.length > 0) console.log(`note: not present here, skipped: ${absent.join(', ')}`)

// 1) Artefacts. Exit 0 is a pass, 1 means class A was found, anything else is
// the tool failing rather than a finding — the two must not be confused.
show('artefacts in the documentation (humanizer-markers, class A):', probe.out)
if (probe.status === 1) problems.push('class A chat-insertion artefacts found in the documentation')
else if (probe.status !== 0) problems.push(`humanizer-markers could not run (exit ${probe.status})`)

// Class B is a small-but-nonzero false-positive class by the tool's own
// measurement, so it is shown when it appears and never fails the run.
const warned = /предупреждений класса B:\s*(\d+)/.exec(probe.out)
if (warned !== null && Number(warned[1]) > 0) {
  const all = run('humanizer-markers', ['--class', 'all', ...present])
  if (all.missing !== true) {
    const detail = all.out.split('\n').filter((line) => line.startsWith('Найдено маркеров') === false && line.trim() !== '')
    show(`class B markers worth a look (${warned[1]}, never fatal on their own):`, detail.slice(0, 10).join('\n'))
  }
}

// 2) Facts against the last release. Protected terms are load-bearing names and
// commands; losing one is a documentation bug rather than a wording change.
const tag = (git(['describe', '--tags', '--abbrev=0']) ?? '').trim()
if (tag === '') {
  console.log('\nfacts: no release tag to compare against; skipping')
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-cost-prose-'))
  try {
    console.log(`\nfacts against ${tag} (humanizer-facts diff):`)
    for (const file of READMES) {
      const before = git(['show', `${tag}:${file}`])
      if (before === null) continue
      const beforePath = join(scratch, `${file.replace(/[^\w.]/g, '_')}.before`)
      writeFileSync(beforePath, before, 'utf8')
      const diff = run('humanizer-facts', ['diff', '--language', 'auto', '--protect', TERMS, beforePath, file])
      const lost = (diff.out ?? '').split('\n').filter((line) => line.startsWith('lost:'))
      const protectedLost = lost.filter((line) => line.includes('[protected]'))
      const other = lost.filter((line) => line.includes('[protected]') === false)
      console.log(`  ${file}: ${lost.length === 0 ? 'nothing lost' : `${lost.length} fact(s) gone`}`)
      for (const line of protectedLost) console.log(`     ${line}`)
      for (const line of other.slice(0, 6)) console.log(`     ${line}`)
      if (other.length > 6) console.log(`     … and ${other.length - 6} more`)
      if (protectedLost.length > 0) problems.push(`${file} lost a protected term`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// 3) Soft signs: worth reading, never worth failing a build over.
const scan = run('humanizer-scan', ['--genre', 'neutral', 'README.ru.md'])
if (scan.missing !== true) {
  const lines = scan.out.split('\n').filter((line) => line.trim() !== '')
  show('soft style signs in README.ru.md (humanizer-scan):', lines.slice(-5).join('\n'))
}

if (problems.length > 0) {
  console.error('\nprose check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\nprose check passed')
