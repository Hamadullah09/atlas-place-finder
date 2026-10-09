# Software Stack Documentation

Technical documentation of what this project is actually built from: every
technology, its version, what it is responsible for, and the file in the
repository that proves it.

| File | What it is |
| --- | --- |
| `software_stack_documentation.pdf` | The compiled document — 45 pages, 8 diagrams |
| `software_stack_documentation.tex` | Complete LaTeX source |


## Rebuilding the PDF

Every diagram is TikZ written inline in the `.tex`, so there is no `diagrams/`
folder and no external asset to keep in step — the source is the diagram.

With [Tectonic](https://tectonic-typesetting.github.io) — a single binary that
downloads only the LaTeX packages this document needs:

```bash
tectonic -X compile software_stack_documentation.tex
```

With a full TeX distribution (TeX Live or MiKTeX):

```bash
latexmk -pdf software_stack_documentation.tex
```

Or plain `pdflatex`, run **three times** so the table of contents, the list of
figures, the list of tables and the cross-references all settle:

```bash
pdflatex software_stack_documentation.tex
pdflatex software_stack_documentation.tex
pdflatex software_stack_documentation.tex
```

## LaTeX packages used

`geometry`, `graphicx`, `xcolor`, `booktabs`, `longtable`, `tabularx`, `array`,
`float`, `enumitem`, `fancyhdr`, `amsmath`, `tikz` (libraries: `positioning`,
`shapes.geometric`, `arrows.meta`, `calc`, `fit`, `backgrounds`), `pdflscape`,
`caption`, `hyperref`, `bookmark`, `lmodern`, `babel`.

All are in a standard TeX Live or MiKTeX installation; Tectonic fetches them on
first build.

## Keeping it accurate

The document states a specific commit on its cover page and quotes **locked**
dependency versions from `package-lock.json`, not the declared ranges. If you
update dependencies or change the architecture, the parts most likely to go
stale are:

- Chapter 10 — the dependency tables (locked versions)
- Chapter 20 — the master technology stack table
- Chapter 22 — the evidence appendix
- The commit and date on the cover page

Anything that could not be verified from the repository is deliberately marked
*Not Verified*, *Unknown*, or stated as absent. Please keep that convention
rather than filling the gaps with assumptions — several of those gaps (no
dependency audit, no coverage measurement, no load testing) are findings in
their own right.
