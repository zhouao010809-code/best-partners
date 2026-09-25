import { parentPort, workerData } from 'node:worker_threads';
import XLSX from 'xlsx';

const fail = (code, message) => parentPort.postMessage({ kind: 'error', code, message });

try {
  const { bytes, maxRows, maxCells, maxSheets } = workerData;
  // Keep Excel dates as serials. SheetJS can turn midnight dates into a value
  // one millisecond before midnight depending on the host timezone.
  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer', cellDates: false, dense: true, WTF: false });
  if (workbook.SheetNames.length === 0) {
    fail('COMPANY_METRICS_HEADER_NOT_FOUND', 'Excel 文件没有工作表');
  } else if (workbook.SheetNames.length > maxSheets) {
    fail('COMPANY_METRICS_TOO_LARGE', `工作表数量超过 ${maxSheets}`);
  } else {
    let declaredCells = 0;
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet || !sheet['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      const rows = range.e.r - range.s.r + 1;
      const cols = range.e.c - range.s.c + 1;
      if (rows > maxRows || rows * cols > maxCells) throw Object.assign(new Error(`工作表 ${name} 超过行列上限`), { code: 'COMPANY_METRICS_TOO_LARGE' });
      declaredCells += rows * cols;
      if (declaredCells > maxCells) throw Object.assign(new Error(`Excel 单元格数量超过 ${maxCells}`), { code: 'COMPANY_METRICS_TOO_LARGE' });
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      fail('COMPANY_METRICS_HEADER_NOT_FOUND', 'Excel 首个工作表为空');
    } else {
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
      if (rows.length > maxRows) throw Object.assign(new Error(`Excel 行数超过 ${maxRows}`), { code: 'COMPANY_METRICS_TOO_LARGE' });
      let actualCells = 0;
      for (const row of rows) {
        actualCells += row.length;
        if (actualCells > maxCells) throw Object.assign(new Error(`Excel 单元格数量超过 ${maxCells}`), { code: 'COMPANY_METRICS_TOO_LARGE' });
      }
      parentPort.postMessage({
        kind: 'result',
        rows,
        sheetName,
        date1904: Boolean(workbook.Workbook?.WBProps?.date1904),
        // sheet_to_json starts at !ref rather than at worksheet row zero.
        startRow: sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r : 0
      });
    }
  }
} catch (error) {
  const code = error?.code === 'COMPANY_METRICS_TOO_LARGE' ? error.code : 'COMPANY_METRICS_FILE_UNSUPPORTED';
  fail(code, error instanceof Error ? error.message : 'Excel 文件无法读取');
}
