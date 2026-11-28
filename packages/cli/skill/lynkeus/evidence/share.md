# Sharing a run: report.html, --embed, --push

- `report.html` opens offline in any browser. Its frames and film stay files in the folder: share the folder (a zip, a CI artifact).
- `lynkeus report html <dir> --embed` writes it again with the frames inside as stored; the film stays a file (`--embed-film` inlines it: much bigger, warns above 10 MB).
- `--push` uploads the run and prints its address as soon as the run starts; the report fills case by case.
