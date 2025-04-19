# jupyterlab-a11y-checker

*A successor repository that will soon replace [jupyterlab-a11y-checker repository](https://github.com/berkeley-dsep-infra/jupyterlab-a11y-checker).*

Jupyterlab-a11y-checker is a jupyterLab extension performs accessibility checks on Jupyter Notebooks (on JupyterHub), leveraging the [axe-core engine](https://github.com/dequelabs/axe-core) and custom detection algorithms to align with WCAG 2.0 AA guidelines. It enables authors to identify accessibility issues in their notebooks and provides actionable suggestions to fix them.

To simplify the remediation process, we integrate a Large Language Model (LLM) for generating recommendations. Using Ollama's mistral model, all processing is done locally on JupyterHub, ensuring user data privacy (details on this implementation will be shared in future releases).


### Installation
You can install the extension directly via pip:

```bash
pip install jupyterlab-a11y-checker

Find the package on PyPI [here](https://pypi.org/project/jupyterlab-a11y-checker/).

## Image

| Rule ID                 | Description                                                     | WCAG     | Fix UI     | Status        |
|------------------------|-----------------------------------------------------------------|----------|------------|----------------|
| **1a detect-text-markdown** | Check for presence of alt text in images which are embedded in markdown | WCAG 1.1.1 | Textfield  | Done ✅    |
| **1c detect-image-text**    | Check if image contains text                                 | WCAG 1.1.1 | Textfield  | In progress ⏳   |

---

## Heading

| Rule ID                      | Description                                                     | WCAG     | Fix UI     | Status           |
|-----------------------------|-----------------------------------------------------------------|----------|------------|------------------|
| **3a detect-heading-h1**         | Check for the presence of H1 tag in a notebook               | WCAG 2.4.2 | Textfield  | In progress ⏳       |
| **4a detect-heading-unique**     | Check if the headings are unique                             | WCAG 2.4.6 | TBD        | In progress ⏳       |
| **4b detect-heading-accurate**   | Check if the order of heading is accurate                    | WCAG 2.4.6 | Dropdown   | In progress ⏳       |
| **4c detect-headings-descriptive** | Check if the content of the headings are descriptive and accurate | WCAG 2.4.6 | TBD        | Discussion Needed ❓ |

---

## List

| Rule ID                 | Description                                                                 | WCAG     | Fix UI     | Status             |
|------------------------|-----------------------------------------------------------------------------|----------|------------|--------------------|
| **5a detect-list-tags**      | Check for presence of lists in a notebook without using `ol` or `ul` tags | WCAG 1.3.1 | TBD   | Discussion Needed ❓ |

---

## Table

| Rule ID                 | Description                                                     | WCAG     | Fix UI     | Status   |
|------------------------|-----------------------------------------------------------------|----------|------------|----------|
| **6a detect-table-headers** | Check for row and column headers                             | WCAG 1.3.1 | Dropdown   | Done ✅     |
| **6b detect-table-caption** | Check whether caption was added for a table                  | WCAG 1.3.1 | Textfield  | Done ✅     |
| **6c detect-table-scope**   | Check whether `scope` attribute is present for rows and columns | WCAG 1.3.1 | Apply Button | Done ✅  |

---

## Color

| Rule ID                 | Description                                                                 | WCAG     | Fix UI     | Status             |
|------------------------|-----------------------------------------------------------------------------|----------|------------|--------------------|
| **7a detect-url-ui**         | Check URLs in notebooks are underlined or bolded                         | WCAG 1.4.1 | TBD        | Discussion Required ❓ |
| **8a detect-cc-normal**      | Check if normal text in images have a contrast ratio of 4.5:1 and text contrast in general | WCAG 1.4.3 | Picker     | In progress  ⏳       |
| **8b detect-cc-large**       | Check if large text in images have a contrast ratio of 3:1               | WCAG 1.4.3 | Picker     | In progress ⏳        |

---

## Link

| Rule ID                 | Description                                                                 | WCAG     | Fix UI     | Status   |
|------------------------|-----------------------------------------------------------------------------|----------|------------|----------|
| **9a detect-meta-link**     | Check whether meta information about a link is included for screen readers | WCAG 2.4.4 | TBD        | TBD      |


![UI of a11y_checker](./readme_img.png)

### Contributions Welcome

We’re building this tool for the community, and we’d love your help! Whether it’s adding new accessibility checks, or refining the fix suggestions, your contributions can help this project make a broader impact.

