import type { ReactNode } from 'react'

/**
 * Minimal Markdown renderer for AI reports.
 *
 * Deliberately tiny: headings, bullet lists, and paragraphs only. Engineering Bible §38 says
 * V0.1 must not take on a PDF library, and the same reasoning applies to a Markdown pipeline —
 * the model is instructed to emit a fixed section structure, so a large parser would be dead
 * weight. Anything unrecognised is rendered as plain text, never as HTML.
 *
 * No `dangerouslySetInnerHTML` anywhere: model output is untrusted text and is rendered as React
 * text nodes, so a model that emits markup cannot inject it.
 */

export interface MarkdownBlock {
  kind: 'heading' | 'paragraph' | 'list-item' | 'quote'
  text: string
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.trim().length === 0) continue
    if (/^#{1,6}\s+/.test(line)) {
      blocks.push({ kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') })
      continue
    }
    if (/^>\s?/.test(line)) {
      blocks.push({ kind: 'quote', text: line.replace(/^>\s?/, '') })
      continue
    }
    if (/^([-*+]|\d+\.)\s+/.test(line)) {
      blocks.push({ kind: 'list-item', text: line.replace(/^([-*+]|\d+\.)\s+/, '') })
      continue
    }
    blocks.push({ kind: 'paragraph', text: line })
  }
  return blocks
}

/** Strip the common inline emphasis markers without interpreting any HTML. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
}

export function renderMarkdownBlocks(markdown: string): ReactNode {
  const blocks = parseMarkdownBlocks(markdown)
  const nodes: ReactNode[] = []
  let listBuffer: string[] = []

  const flushList = (key: string) => {
    if (listBuffer.length === 0) return
    nodes.push(
      <ul key={key}>
        {listBuffer.map((item, index) => (
          <li key={`${key}-${index}`}>{stripInlineMarkdown(item)}</li>
        ))}
      </ul>,
    )
    listBuffer = []
  }

  blocks.forEach((block, index) => {
    if (block.kind === 'list-item') {
      listBuffer.push(block.text)
      return
    }
    flushList(`list-${index}`)
    if (block.kind === 'heading') {
      nodes.push(<h3 key={`heading-${index}`}>{stripInlineMarkdown(block.text)}</h3>)
    } else if (block.kind === 'quote') {
      nodes.push(
        <blockquote key={`quote-${index}`} className="report-quote">
          {stripInlineMarkdown(block.text)}
        </blockquote>,
      )
    } else {
      nodes.push(<p key={`p-${index}`}>{stripInlineMarkdown(block.text)}</p>)
    }
  })
  flushList('list-final')
  return nodes
}
