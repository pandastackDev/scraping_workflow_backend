import XLSX from 'xlsx';

export async function exportToExcel(data, filename = 'exhibitors') {
  // Prepare data for Excel
  const excelData = data.map(item => ({
    'Company Name': item.companyName || '',
    'Booth': item.booth || '',
    'Website': item.website || '',
    'Source': item.source || ''
  }));

  // Create workbook and worksheet
  const worksheet = XLSX.utils.json_to_sheet(excelData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Exhibitors');

  // Set column widths
  worksheet['!cols'] = [
    { wch: 40 }, // Company Name
    { wch: 15 }, // Booth
    { wch: 40 }, // Website
    { wch: 15 }  // Source
  ];

  // Convert to buffer
  const buffer = XLSX.write(workbook, { 
    type: 'buffer', 
    bookType: 'xlsx' 
  });

  return buffer;
}

