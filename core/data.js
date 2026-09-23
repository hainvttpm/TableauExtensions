// @ts-check
/* global tableau */

/**
 * data.js — đọc dữ liệu & encoding từ worksheet.
 *
 * Các hàm ở đây tái sử dụng cho MỌI viz — KHÔNG cần sửa khi build viz mới.
 * Pattern bám sát MIT sample tableau/extensions-api (Samples/Viz/Sankey).
 *
 * Khái niệm cốt lõi:
 *  - $tupleId: danh tính hàng do TA tự gán (1-indexed, tuần tự qua các trang).
 *    API không cấp sẵn — ta gán trong convertToNamedRows và mang nó xuyên suốt
 *    tới D3 để selectTuplesAsync / hoverTupleAsync hoạt động.
 *  - encodingMap: map từ encoding.id (khai báo trong .trex) → mảng field.
 *    Một encoding VẮNG MẶT nếu user chưa thả field lên shelf đó → luôn guard.
 */

/**
 * Chuyển một page dữ liệu (list DataValue + columns) thành list các row-object
 * map từ fieldName → DataValue, kèm $tupleId.
 * @param {any} dataTablePage  DataTablePage từ reader.getPageAsync()
 * @param {number} tupleIdBase  giá trị $tupleId cho hàng đầu của page (1-indexed)
 * @returns {Array<Record<string, any>>}
 */
export function convertToNamedRows(dataTablePage, tupleIdBase) {
  const rows = [];
  const { columns, data } = dataTablePage;
  for (let i = 0; i < data.length; i++) {
    const row = { $tupleId: tupleIdBase + i };
    for (let j = 0; j < columns.length; j++) {
      row[columns[j].fieldName] = data[i][columns[j].index];
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Đọc toàn bộ summary data của worksheet qua DataTableReader (phân trang).
 * LƯU Ý: getSummaryData trả rows theo thứ tự ĐẢO → ta reverse() lại.
 * getSummaryDataTableAsync() KHÔNG tồn tại ở API hiện tại — phải dùng reader.
 * @param {any} worksheet
 * @param {number} [pageSize=10000]
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function getSummaryData(worksheet, pageSize = 10000) {
  const reader = await worksheet.getSummaryDataReaderAsync(pageSize, {
    ignoreSelection: true,
    applyWorksheetFormatting: true,
  });

  let rows = [];
  for (let page = 0; page < reader.pageCount; page++) {
    const dataTablePage = await reader.getPageAsync(page);
    rows = rows.concat(convertToNamedRows(dataTablePage, page * pageSize + 1));
  }
  await reader.releaseAsync(); // luôn release reader

  return rows.reverse();
}

/**
 * Đọc map encoding từ getVisualSpecificationAsync().
 * Key = encoding.id trong .trex; value = mảng field object ({ name, ... }).
 * Trả {} nếu chưa có marks card active (activeMarksSpecificationIndex < 0).
 * @param {any} worksheet
 * @returns {Promise<Record<string, Array<{name: string}>>>}
 */
export async function getEncodingMap(worksheet) {
  const visualSpec = await worksheet.getVisualSpecificationAsync();

  /** @type {Record<string, Array<{name: string}>>} */
  const encodingMap = {};
  if (visualSpec.activeMarksSpecificationIndex < 0) return encodingMap;

  const marksCard =
    visualSpec.marksSpecifications[visualSpec.activeMarksSpecificationIndex];
  for (const encoding of marksCard.encodings) {
    if (!encodingMap[encoding.id]) encodingMap[encoding.id] = [];
    encodingMap[encoding.id].push(encoding.field);
  }
  return encodingMap;
}

/**
 * Re-key mỗi row từ { fieldName → DataValue } sang { encodingId → DataValue[] }.
 * Giữ nguyên $tupleId. Encoding chưa được thả field sẽ vắng mặt → renderer guard
 * bằng row.x?.[0]?.value.
 * @param {Array<Record<string, any>>} rows  output của getSummaryData
 * @param {Record<string, Array<{name: string}>>} encodingMap
 * @returns {Array<Record<string, any>>}
 */
export function getEncodedData(rows, encodingMap) {
  return rows.map((row) => {
    const encoded = { $tupleId: row.$tupleId };
    for (const encId in encodingMap) {
      encoded[encId] = encodingMap[encId].map((field) => row[field.name]);
    }
    return encoded;
  });
}
