// A faster drop-in for csv-reader 1.0.0: run(input) returns csv-reader's answer
// {columns, rows, errors} for {text, header}, reading the text once left to
// right. Written from the reference's stated policy (RULES.txt) in my own
// structure: indexOf-based field scans instead of the reference's
// character-at-a-time walk, with the broken-row errors (stray_cr,
// quote_junk, unterminated_quote, short_row, long_row) recorded exactly as
// the reference records them: every error carries the line its record starts
// on (counting every LF, CRLF and lone CR inside quotes) and its index in
// rows, null for the header.
//
// How it stays fast: every delimiter is found through precomputed lists of
// LF, CR and quote positions, so the next comma, line break or stray CR is an
// O(1) look instead of a scan; a record with no quote before its line end
// is split on commas by one native call; a quoted field's content is one
// slice whenever it holds no line break, so the common field costs a look
// and a slice, not a loop over its characters.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  // Positions of every CR, every LF and every quote in the text, so a stray
  // CR, the next line break and the next quote can be found without an
  // unbounded indexOf scan (most texts hold very few CRs, and a scan for one
  // past a field's end would otherwise walk the rest of the text). crPtr,
  // lfPtr and qPtr always point at the first CR / LF / quote at or after the
  // current read position.
  const crs = [];
  const lfs = [];
  const quotes = [];
  {
    let i = text.indexOf('\r');
    while (i !== -1) {
      crs.push(i);
      i = text.indexOf('\r', i + 1);
    }
    let j = text.indexOf('\n');
    while (j !== -1) {
      lfs.push(j);
      j = text.indexOf('\n', j + 1);
    }
    let k = text.indexOf('"');
    while (k !== -1) {
      quotes.push(k);
      k = text.indexOf('"', k + 1);
    }
  }
  let crPtr = 0;
  let lfPtr = 0;
  let qPtr = 0;

  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on, and its index in rows
  // (null while the header is still unread).
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote before its line end holds no quoted
    // field, and with no stray CR either its fields are the line split on
    // commas (a CR right before the LF is the CRLF ending, not a stray one).
    while (lfPtr < lfs.length && lfs[lfPtr] < pos) lfPtr += 1;
    while (qPtr < quotes.length && quotes[qPtr] < pos) qPtr += 1;
    while (crPtr < crs.length && crs[crPtr] < pos) crPtr += 1;
    const iL = lfPtr < lfs.length ? lfs[lfPtr] : -1;
    const iQ = qPtr < quotes.length ? quotes[qPtr] : -1;
    const iR = crPtr < crs.length ? crs[crPtr] : -1;
    const lineEnd = iL === -1 ? n : iL;
    let fields;
    let quoted = false;
    if ((iQ === -1 || iQ >= lineEnd) && (iR === -1 || iR >= lineEnd || (iL !== -1 && iR === lineEnd - 1))) {
      let contentEnd = lineEnd;
      if (iL !== -1 && iR === lineEnd - 1) contentEnd -= 1;
      fields = text.slice(pos, contentEnd).split(',');
      if (iL !== -1) { pos = iL + 1; line += 1; } else { pos = n; }
    } else {
    fields = [];
    for (;;) {
      // ---- one field ----
      let value = '';
      let ended = 2;
      const isQuoted = text.charCodeAt(pos) === 34;
      quoted = isQuoted;
      let needJunk = false;
      let done = false;
      if (isQuoted) {
        // A field that opens with a quote runs to the next quote that is
        // not doubled.
        const open = pos;
        const openLine = line;
        pos += 1;
        let chunkStart = pos;
        let closed = false;
        for (;;) {
          while (qPtr < quotes.length && quotes[qPtr] < pos) qPtr += 1;
          const q = qPtr < quotes.length ? quotes[qPtr] : -1;
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            pos = open + 1;
            line = openLine;
            while (crPtr > 0 && crs[crPtr - 1] >= pos) crPtr -= 1;
            while (lfPtr > 0 && lfs[lfPtr - 1] >= pos) lfPtr -= 1;
            while (qPtr > 0 && quotes[qPtr - 1] >= pos) qPtr -= 1;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            value = '"';
            break;
          }
          // Append the chunk [chunkStart, q): one slice when it holds no
          // line break, otherwise each CRLF or lone CR inside it read as
          // LF, and every line break counted.
          while (crPtr < crs.length && crs[crPtr] < chunkStart) crPtr += 1;
          while (lfPtr < lfs.length && lfs[lfPtr] < chunkStart) lfPtr += 1;
          const hasCR = crPtr < crs.length && crs[crPtr] < q;
          const hasLF = lfPtr < lfs.length && lfs[lfPtr] < q;
          if (!hasCR && !hasLF) {
            value += text.slice(chunkStart, q);
          } else {
            let s = chunkStart;
            let i = chunkStart;
            while (i < q) {
              const c = text.charCodeAt(i);
              if (c === 13) {
                if (i > s) value += text.slice(s, i);
                value += '\n';
                line += 1;
                i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
                s = i;
              } else {
                if (c === 10) line += 1;
                i += 1;
              }
            }
            if (q > s) value += text.slice(s, q);
          }
          if (text.charCodeAt(q + 1) === 34) {
            // "" inside the field is one quote; the field goes on.
            value += '"';
            pos = q + 2;
            chunkStart = pos;
            continue;
          }
          pos = q + 1;
          closed = true;
          break;
        }
        if (closed) {
          if (pos >= n) { ended = 2; done = true; }
          else {
            const c = text.charCodeAt(pos);
            if (c === 44) { pos += 1; ended = 0; done = true; }
            else if (c === 10) { pos += 1; line += 1; ended = 1; done = true; }
            else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = 1; done = true; }
            else needJunk = true;
          }
        }
      }
      if (!done) {
        // Unquoted read: a plain field, the text after a closing quote, or
        // the re-read after a quote that never closes. Up to the next comma
        // or line break; a CR not followed by LF is dropped (stray_cr).
        let added = 0;
        let segStart = pos;
        for (;;) {
          const iC = text.indexOf(',', pos);
          while (lfPtr < lfs.length && lfs[lfPtr] < pos) lfPtr += 1;
          const iL = lfPtr < lfs.length ? lfs[lfPtr] : -1;
          while (crPtr < crs.length && crs[crPtr] < pos) crPtr += 1;
          const iR = crPtr < crs.length ? crs[crPtr] : -1;
          let end = n;
          let kind = 2;
          if (iC !== -1 && iC < end) { end = iC; kind = 0; }
          if (iL !== -1 && iL < end) { end = iL; kind = 1; }
          if (iR !== -1 && iR < end) { end = iR; kind = 3; }
          if (kind === 2) {
            if (end > segStart) { value += text.slice(segStart, end); added += end - segStart; }
            pos = n;
            ended = 2;
            break;
          }
          if (kind === 0) {
            if (end > segStart) { value += text.slice(segStart, end); added += end - segStart; }
            pos = end + 1;
            ended = 0;
            break;
          }
          if (kind === 1) {
            if (end > segStart) { value += text.slice(segStart, end); added += end - segStart; }
            pos = end + 1;
            line += 1;
            ended = 1;
            break;
          }
          if (text.charCodeAt(end + 1) === 10) {
            if (end > segStart) { value += text.slice(segStart, end); added += end - segStart; }
            pos = end + 2;
            line += 1;
            ended = 1;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (end > segStart) { value += text.slice(segStart, end); added += end - segStart; }
          pos = end + 1;
          segStart = pos;
        }
        if (needJunk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      fields.push(value);
      if (ended !== 0) break;
    }
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
