import { StandardFonts } from 'pdf-lib';

/**
 * The editor offers the three font families every PDF reader has built in, so
 * text stays real (selectable, searchable) text in the saved file. On screen we
 * use the metric-compatible system fonts.
 */
export const FONT_CSS = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};

export function fontKey(css = '') {
  if (/courier|mono/i.test(css)) return 'mono';
  if (/sans/i.test(css)) return 'sans';
  if (/times|serif/i.test(css)) return 'serif';
  return 'sans';
}

export function isBold(weight) {
  return weight === 'bold' || Number(weight) >= 600;
}

export function isItalic(style) {
  return style === 'italic' || style === 'oblique';
}

const PDF_FONTS = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export function standardFontFor(textObj) {
  const fam = PDF_FONTS[fontKey(textObj.fontFamily)];
  return fam[(isBold(textObj.fontWeight) ? 1 : 0) + (isItalic(textObj.fontStyle) ? 2 : 0)];
}
