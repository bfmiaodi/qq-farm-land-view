# QQ Farm Catalog Export

Generated at: 2026-05-10T16:09:55.245Z

## Files

- `qq-farm-catalog.sqlite`: SQLite database, easiest to share and query.
- `qq-farm-catalog.json`: full structured export.
- `qq-farm-catalog.csv`: spreadsheet-friendly catalog export.
- `qq-farm-catalog-missing.csv`: rows that still need a real name or image.
- `qq-farm-catalog-summary.json`: export statistics.
- `images/`: copied local item, seed, and plant images referenced by the export.

## Summary

Total: 982
Complete: 977
Incomplete: 5

| Category | Total | Complete | Incomplete |
| --- | ---: | ---: | ---: |
| item | 656 | 651 | 5 |
| seed | 152 | 152 | 0 |
| plant | 174 | 174 | 0 |

## Remaining Issues

| Issue | Count |
| --- | ---: |
| missing_image | 5 |

## Regenerate

```powershell
node tools\export-catalog-database.js
python tools\catalog-json-to-sqlite.py
```

If the default export files are open in a spreadsheet app, export to another directory:

```powershell
$env:QQ_FARM_CATALOG_EXPORT_DIR = "core\data\catalog-export-latest"
node tools\export-catalog-database.js
python tools\catalog-json-to-sqlite.py core\data\catalog-export-latest\qq-farm-catalog.json core\data\catalog-export-latest\qq-farm-catalog.sqlite
```
