// The sprite render's work off the page's thread (see SpriteRenderer.render()
// in sprite-render.js): the frames drawn are read back from the graphics
// card in batches - many frames side by side in one picture - and here they
// are cut out, turned the right way up, made every pixel there or not (pixel
// art's edges), and put in their places on the sheets; at the end the sheets
// are given back as pictures to show, or as PNG files to write.
//
// One job at a time, by its number; what comes for another is let go.
//   { type: 'begin', job, sheets: [{ w, h }] }
//   { type: 'tiles', job, buffer, width, tiles: [{ gx, gy, w, h, sheet, x, y }] }
//       `buffer`: RGBA rows from the bottom, `width` px each; a tile's
//       corner (gx, gy) counts from the bottom left, its place on its
//       sheet (x, y) from the top left
//   { type: 'end', job, png }  ->  { job, results: ImageBitmap[] | Uint8Array[] }
//   { type: 'cancel', job }

const ALPHA_CUT = 128; // a pixel is there from this alpha on (as sprite-render.js)

let current = null; // { job, sheets: [{ w, h, data }] }

self.onmessage = async ({ data: message }) => {
  if (message.type === 'begin') {
    current = { job: message.job, sheets: message.sheets.map(({ w, h }) => ({ w, h, data: new Uint8ClampedArray(w * h * 4) })) };
    return;
  }
  if (!current || message.job !== current.job) return;
  if (message.type === 'cancel') {
    current = null;
    return;
  }
  if (message.type === 'tiles') {
    const source = new Uint8Array(message.buffer);
    for (const tile of message.tiles) place(source, message.width, tile, current.sheets[tile.sheet]);
    return;
  }
  if (message.type === 'end') {
    const { job, sheets } = current;
    current = null;
    const results = await Promise.all(sheets.map(async ({ w, h, data }) => {
      const image = new ImageData(data, w, h);
      if (!message.png) return createImageBitmap(image);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').putImageData(image, 0, 0);
      return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    }));
    self.postMessage({ job, results }, results.map((result) => (result instanceof Uint8Array ? result.buffer : result)));
  }
};

// A tile of the read-back picture onto its sheet: row by row, top first,
// every pixel there (alpha 255) or clear.
function place(source, width, tile, sheet) {
  const { data } = sheet;
  for (let row = 0; row < tile.h; row++) {
    const from = ((tile.gy + tile.h - 1 - row) * width + tile.gx) * 4;
    const to = ((tile.y + row) * sheet.w + tile.x) * 4;
    for (let i = 0; i < tile.w * 4; i += 4) {
      if (source[from + i + 3] < ALPHA_CUT) continue;
      data[to + i] = source[from + i];
      data[to + i + 1] = source[from + i + 1];
      data[to + i + 2] = source[from + i + 2];
      data[to + i + 3] = 255;
    }
  }
}
