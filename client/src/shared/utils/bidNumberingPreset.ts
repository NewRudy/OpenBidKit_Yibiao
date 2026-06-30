import type { ExportFormatConfig } from '../types/exportFormat';

const BID_NUMBERING_TEMPLATES = ['{num}）', '{num}）', '{circled}', '{alpha})', '', ''] as const;

export const BID_NUMBERING_PREVIEW_LINES = [
  '1）一级序号',
  '1）二级序号',
  '①三级序号',
  'a)四级序号',
  '五级序号',
] as const;

export function applyBidNumberingPreset(config: ExportFormatConfig): ExportFormatConfig {
  return {
    ...config,
    headings: config.headings.map((heading, index) => ({
      ...heading,
      numbering_format: 'custom',
      numbering_template: BID_NUMBERING_TEMPLATES[index] || '',
    })),
  };
}

export function isBidNumberingPreset(config: ExportFormatConfig): boolean {
  return BID_NUMBERING_TEMPLATES.every((template, index) => config.headings[index]?.numbering_template === template);
}
