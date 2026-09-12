/**
 * Keeps the three language versions of the documentation in step: same shape,
 * cross-linked, and covering the same facts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = [
  { file: 'README.md', language: 'English', links: ['README.zh.md', 'README.ru.md'] },
  { file: 'README.zh.md', language: 'Chinese', links: ['README.md', 'README.ru.md'] },
  { file: 'README.ru.md', language: 'Russian', links: ['README.md', 'README.zh.md'] }
]

const documents = await Promise.all(DOCS.map(async (entry) => ({
  ...entry,
  text: await readFile(join(root, entry.file), 'utf8')
})))

test('every language version exists, is substantial, and links to the other two', () => {
  for (const doc of documents) {
    assert.ok(doc.text.length > 1500, `${doc.file} has real content`)
    for (const link of doc.links) {
      assert.ok(doc.text.includes(link), `${doc.file} links to ${link}`)
    }
  }
})

test('the three versions share one section structure', () => {
  const shapes = documents.map((doc) => ({
    file: doc.file,
    sections: doc.text.split('\n').filter((line) => line.startsWith('## ')).length,
    codeBlocks: (doc.text.match(/```/g) || []).length
  }))
  const reference = shapes[0]
  for (const shape of shapes) {
    assert.equal(shape.sections, reference.sections, `${shape.file} has the same number of sections`)
    assert.equal(shape.codeBlocks, reference.codeBlocks, `${shape.file} has the same number of code blocks`)
    assert.equal(shape.codeBlocks % 2, 0, `${shape.file} closes every code block`)
  }
})

test('every version documents the same load-bearing facts', () => {
  const facts = ['dsh-chat-cost', 'dsh plugin --profile web add', 'npm test', '.dsh-cost/cost.jsonl', 'models.dev', 'MIT']
  for (const doc of documents) {
    for (const fact of facts) {
      assert.ok(doc.text.includes(fact), `${doc.file} documents ${fact}`)
    }
  }
})

/** The git blob hash of a file's content, computed without a repository. */
function gitBlobHash(content) {
  const body = Buffer.from(content, 'utf8')
  const header = Buffer.from(`blob ${body.length}\u0000`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, body])).digest('hex')
}

test('the pairing record matches the shipped READMEs', async () => {
  const record = await readFile(join(root, 'README.i18n.yaml'), 'utf8')
  for (const doc of documents) {
    const recorded = record.match(new RegExp(`^${doc.file.replace('.', '\\.')}: ([0-9a-f]{40})$`, 'm'))
    assert.ok(recorded !== null, `${doc.file} is recorded`)
    assert.equal(recorded[1], gitBlobHash(doc.text), `${doc.file} hash is current — re-record README.i18n.yaml after editing`)
  }
})

test('the pairing record lists all three README hashes', async () => {
  const record = await readFile(join(root, 'README.i18n.yaml'), 'utf8')
  for (const doc of documents) {
    assert.match(record, new RegExp(`^${doc.file.replace('.', '\\.')}: [0-9a-f]{40}$`, 'm'), `${doc.file} is recorded`)
  }
})
