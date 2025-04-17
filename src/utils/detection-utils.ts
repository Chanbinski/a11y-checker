import axe from 'axe-core';
import { marked } from 'marked';
import { NotebookPanel } from '@jupyterlab/notebook';
import { getTextInImage } from './ai-utils';

import { ICellIssue } from './types';

export async function analyzeCellsAccessibility(
  panel: NotebookPanel
): Promise<ICellIssue[]> {
  const notebookIssues: ICellIssue[] = [];

  const tempDiv = document.createElement('div');
  document.body.appendChild(tempDiv);

  const axeConfig: axe.RunOptions = {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']
  };

  try {
    const cells = panel.content.widgets;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell || !cell.model) {
        console.warn(`Skipping cell ${i}: Invalid cell or model`);
        continue;
      }

      const cellType = cell.model.type;
      if (cellType === 'markdown') {
        const rawMarkdown = cell.model.sharedModel.getSource();
        if (rawMarkdown.trim()) {
          tempDiv.innerHTML = await marked.parse(rawMarkdown);

          // SUGGESTION: What if we limit axe to detect only the rules we want?
          const results = await axe.run(tempDiv, axeConfig);
          const violations = results.violations;

          // Can have multiple violations in a single cell
          if (violations.length > 0) {
            violations.forEach(violation => {
              violation.nodes.forEach(node => {
                notebookIssues.push({
                  cellIndex: i,
                  cellType: cellType,
                  violation: {
                    id: violation.id,
                    description: violation.description,
                    descriptionUrl: violation.helpUrl
                  },
                  issueContentRaw: node.html
                });
              });
            });
          }

          // Add custom image issue detection
          notebookIssues.push(
            ...(await detectImageIssuesInCell(rawMarkdown, i, cellType))
          );
          notebookIssues.push(
            ...detectTableIssuesInCell(rawMarkdown, i, cellType)
          );
          extractAndProcessImages(rawMarkdown);
        }
      } else if (cellType === 'code') {
        const codeInput = cell.node.querySelector('.jp-InputArea-editor');
        const codeOutput = cell.node.querySelector('.jp-OutputArea');
        if (codeInput || codeOutput) {
          // We would have to feed this into a language model to get the suggested fix.
        }
      }
    }
  } finally {
    tempDiv.remove();
  }

  return notebookIssues;
}

// Image
async function detectImageIssuesInCell(
  rawMarkdown: string,
  cellIndex: number,
  cellType: string
): Promise<ICellIssue[]> {
  const notebookIssues: ICellIssue[] = [];

  // Check for images without alt text in markdown syntax
  const mdSyntaxMissingAltRegex = /!\[\]\([^)]+\)/g;

  // Check for images without alt tag or empty alt tag in HTML syntax
  const htmlSyntaxMissingAltRegex = /<img[^>]*alt=""[^>]*>/g;
  let match;
  while (
    (match = mdSyntaxMissingAltRegex.exec(rawMarkdown)) !== null ||
    (match = htmlSyntaxMissingAltRegex.exec(rawMarkdown)) !== null
  ) {
    const imageUrl =
      match[0].match(/\(([^)]+)\)/)?.[1] ||
      match[0].match(/src="([^"]+)"/)?.[1];
    if (imageUrl) {
      let suggestedFix: string = '';
      try {
        const ocrResult = await getTextInImage(imageUrl);
        if (ocrResult.confidence > 40) {
          suggestedFix = ocrResult.text.replace(/["~|_\-/=]/g, ' ');
        }
      } catch (error) {
        console.error(`Failed to process image ${imageUrl}:`, error);
      } finally {
        notebookIssues.push({
          cellIndex,
          cellType: cellType as 'code' | 'markdown',
          violation: {
            id: 'image-alt',
            description: 'Images must have alternate text',
            descriptionUrl:
              'https://dequeuniversity.com/rules/axe/4.7/image-alt'
          },
          issueContentRaw: match[0],
          suggestedFix: suggestedFix
        });
      }
    }
  }
  return notebookIssues;
}

// Table
function detectTableIssuesInCell(
  rawMarkdown: string,
  cellIndex: number,
  cellType: string
): ICellIssue[] {
  const notebookIssues: ICellIssue[] = [];

  // Check for tables without th tags
  const tableWithoutThRegex =
    /<table[^>]*>(?![\s\S]*?<th[^>]*>)[\s\S]*?<\/table>/gi;
  let match;
  while ((match = tableWithoutThRegex.exec(rawMarkdown)) !== null) {
    notebookIssues.push({
      cellIndex,
      cellType: cellType as 'code' | 'markdown',
      violation: {
        id: 'td-has-header',
        description: 'Tables must have header information',
        descriptionUrl:
          'https://dequeuniversity.com/rules/axe/4.10/td-has-header?application=RuleDescription'
      },
      issueContentRaw: match[0]
    });
  }

  // Check for tables without caption tags
  const tableWithoutCaptionRegex =
    /<table[^>]*>(?![\s\S]*?<caption[^>]*>)[\s\S]*?<\/table>/gi;
  while ((match = tableWithoutCaptionRegex.exec(rawMarkdown)) !== null) {
    notebookIssues.push({
      cellIndex,
      cellType: cellType as 'code' | 'markdown',
      violation: {
        id: 'table-has-caption',
        description: 'Tables must have caption information',
        descriptionUrl: ''
      },
      issueContentRaw: match[0]
    });
  }
  return notebookIssues;
}

// TODO: Headings

// TODO: Color

// TODO: Links

// TODO: Other

export async function extractAndProcessImages(
  rawMarkdown: string
): Promise<{ text: string; confidence: number }[]> {
  const imageUrls: string[] = [];

  // Match markdown image syntax: ![alt](url)
  const mdImageRegex = /!\[.*?\]\((.*?)\)/g;
  let match;
  while ((match = mdImageRegex.exec(rawMarkdown)) !== null) {
    imageUrls.push(match[1]);
  }

  // Match HTML img tags: <img src="url" ...>
  const htmlImageRegex = /<img[^>]+src="([^">]+)"/g;
  while ((match = htmlImageRegex.exec(rawMarkdown)) !== null) {
    imageUrls.push(match[1]);
  }

  // Process each image URL
  const results: { text: string; confidence: number }[] = [];
  for (const url of imageUrls) {
    try {
      const result = await getTextInImage(url);
      console.log(result);
    } catch (error) {
      console.error(`Failed to process image ${url}:`, error);
    }
  }

  return results;
}
