# https://www.espn.com.ar/futbol-americano/nfl/fpi

teams = Array.prototype.slice.call(document.getElementsByClassName('TeamLink__Name')).map((x) => x.innerText)
fpi = Array.prototype.slice.call($0.getElementsByTagName('tr')).map((x) => `(${parseFloat(x.getElementsByTagName('td')[1].innerText)})`)
function toDictionary(keys, values) {
  return keys.reduce((acc, key, i) => {
    acc[key] = values[i];
    return acc;
  }, {});
}
JSON.stringify(toDictionary(teams, fpi))


function createFpiMap(htmlContent) {
  // Determine context: Use provided string (parsed) or global document
  let doc;
  if (typeof htmlContent === 'string') {
    doc = new DOMParser().parseFromString(htmlContent, 'text/html');
  } else {
    doc = document;
  }

  const fpiMap = {};

  // Select rows from the fixed (team names) table and the scrollable (data) table
  // The ESPN structure splits these into two separate tables that align by index
  const teamRows = doc.querySelectorAll('.Table--fixed-left tbody tr');
  const dataRows = doc.querySelectorAll('.Table__Scroller tbody tr');

  teamRows.forEach((teamRow, index) => {
    // 1. Extract Team Name
    // Located in: .TeamLink__Name -> a tag
    const nameElement = teamRow.querySelector('.TeamLink__Name a');
    if (!nameElement) return;
    const teamName = nameElement.textContent.trim();

    // 2. Extract FPI Value
    // Located in the corresponding row of the scrollable table
    // The FPI is consistently in the 2nd column (index 1) based on the header structure
    const dataRow = dataRows[index];
    if (dataRow) {
      const cells = dataRow.querySelectorAll('td');
      if (cells.length > 1) {
        const fpiText = cells[1].textContent.trim();
        fpiMap[teamName] = parseFloat(fpiText);
      }
    }
  });

  return fpiMap;
};JSON.stringify(createFpiMap(document.getElementsByClassName('Card')[0].outerHTML))
