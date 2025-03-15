import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { NotebookPanel, Notebook } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';
import { LabIcon } from '@jupyterlab/ui-components';
import { ILabShell } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { Cell, CodeCell, ICellModel, MarkdownCell } from '@jupyterlab/cells';
import { INotebookTracker } from '@jupyterlab/notebook';
import axe from 'axe-core';
import axios from 'axios';
//import Tesseract from 'tesseract.js';

// Track if model has been pulled
let isModelPulled = false;

// Track if functionality is enabled
let isEnabled = true;

// Types and Interfaces
interface CellAccessibilityIssue {
    cellIndex: number;
    cellType: string;
    axeResults: axe.Result[];
    contentRaw: string;
}

// Core Analysis Functions
async function analyzeCellsAccessibility(panel: NotebookPanel): Promise<CellAccessibilityIssue[]> {
    const issues: CellAccessibilityIssue[] = [];
    
    const tempDiv = document.createElement('div');
    document.body.appendChild(tempDiv);

    const axeConfig: axe.RunOptions = {
        runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    };

    try {
        const cells = panel.content.widgets;
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (!cell || !cell.model) {
                console.warn(`Skipping cell ${i}: Invalid cell or model`);
                continue;
            }

            const cellType = cell.model.type;
            if (cellType === 'markdown') {
                const markdownOutput = cell.node.querySelector('.jp-MarkdownOutput')
                if (markdownOutput) {
                    // First check rendered markdown
                    tempDiv.innerHTML = markdownOutput.innerHTML;
                    if (tempDiv.innerHTML.trim()) {
                        const renderedResults = await axe.run(tempDiv, axeConfig);
                        const renderedViolations = renderedResults.violations;

                        // Then check raw markdown
                        tempDiv.innerHTML = cell.model.sharedModel.getSource();
                        const rawResults = await axe.run(tempDiv, axeConfig);
                        const rawViolations = rawResults.violations;

                        // Combine violations and filter duplicates based on issue ID
                        const allViolations = [...renderedViolations, ...rawViolations];
                        const uniqueViolations = allViolations.filter((violation, index, self) =>
                            index === self.findIndex(v => v.id === violation.id)
                        );

                        if (uniqueViolations.length > 0) {
                            issues.push({
                                cellIndex: i,
                                cellType: cellType,
                                axeResults: uniqueViolations,
                                contentRaw: cell.model.sharedModel.getSource(),
                            });
                        }
                    }
                }
            } else if (cellType === 'code') {
                const codeInput = cell.node.querySelector('.jp-InputArea-editor')
                const codeOutput = cell.node.querySelector('.jp-OutputArea')
                if (codeInput || codeOutput) {
                    // We would have to feed this into a language model to get the suggested fix.
                }
            }
        }
    } finally {
        tempDiv.remove();
    }

    return issues;
}

// AI Integration Functions
function formatPrompt(issue: CellAccessibilityIssue): string {
    let prompt = `The following represents a jupyter notebook cell and a accessibility issue found in it.\n\n`;

    const cellIssue = issue;
    prompt += `Content: \n${cellIssue.contentRaw}\n\n`;
    cellIssue.axeResults.forEach(issue => {
        prompt += `Issue: ${issue.id}\n\n`;
        prompt += `Description: ${issue.description}\n\n`;
    });

    prompt += `Respond in JSON format with the following fields:
    - exampleCellContent: A suggested fix for the cell, without any explanation.
    - explanation: An explanation of the issue and the suggested fix.
    `;

    return prompt;
}

async function getFixSuggestions(prompt: string, userURL: string, modelName: string): Promise<string[]> {
    try {
        // Only pull model on first API call
        if (!isModelPulled) {
            await pullOllamaModel(userURL, modelName);
            console.log("Model pulled");
            isModelPulled = true;
        }
        
        let body = JSON.stringify({ 
            model: modelName,
            prompt: prompt,
            stream: false
        });
        
        const response = await axios.post(
            userURL + "api/generate",
            body,
            {
              headers: { 'Content-Type': 'application/json' }
            }
        );
        const responseText = await response.data.response.trim();
        const responseObj = JSON.parse(responseText); 
        console.log(responseText)   
        try {
            return [responseObj.exampleCellContent || '', responseObj.explanation || ''];
        } catch (e) {
            console.error('Failed to parse suggestion:', e);
            return ['Invalid response format', ''];
        }
    } catch (error) {
        console.error('Error getting suggestions:', error);
        return ['Error', ''];
    }
}

async function pullOllamaModel(userURL: string, modelName: string): Promise<void> {
    try {
      const payload = {
        name: modelName,
        stream: false,
        options: {
          low_cpu_mem_usage: true,
          use_fast_tokenizer: true,
        }
      };
  
      // Instead of aborting, let's just monitor the time
      console.log("Starting model pull...");
  
      const response = await axios.post(
        userURL + "api/pull",
        payload,
        { headers: { 'Content-Type': 'application/json' } }
      );
  
      if (response.status !== 200) {
        throw new Error('Failed to pull model');
      }
    } catch (error) {
      console.error('Error pulling model:', error);
      throw error;
    }
}
  

// UI Components
class CellIssueWidget extends Widget {
    private currentNotebook: NotebookPanel | null = null;
    private cellIndex: number;
    private suggestion: string = '';
    private _userOllamaUrl: string;

    constructor(issue: CellAccessibilityIssue, notebook: NotebookPanel, notebookTracker: INotebookTracker) {
        super();
        this.addClass('jp-A11yPanel-issue');
        this.currentNotebook = notebook;
        this.cellIndex = issue.cellIndex;
        this._userOllamaUrl = (ServerConnection.makeSettings().baseUrl || PageConfig.getBaseUrl()) + "ollama/";



        // Header Container UI
        const buttonContainer = document.createElement('div');
        buttonContainer.innerHTML = `
            <div class="jp-A11yPanel-buttonContainer">
                <button class="jp-text-button jp-level1 jp-MainIssueButton" style="background-color: #e0e0e0;">
                Issue: ${issue.axeResults.map((result: any) => result.id).join(', ')}
                </button>
                <span class="jp-A11yPanel-infoIcon">&#9432;</span>
                <div class="jp-A11yPanel-popup">
                ${issue.axeResults
                    .map((result: any) => `
                    <div class="jp-A11yPanel-popupDetail">
                        <strong>${result.id}</strong><br>
                        Impact: ${result.impact}<br>
                        Description: ${result.description}<br>
                        Help: ${result.help}<br>
                        Help URL: <a href="${result.helpUrl}" target="_blank">Learn more</a>
                    </div>
                    `)
                    .join('')}
                </div>
            </div>
            <div class="jp-level2-buttons" style="display: none; margin-left: 10px; margin-right: 10px; background-color: white; border: 1px solid black; padding: 5px;">
                <button class="jp-text-button jp-level2 jp-NavigateToCellButton" style="background-color: #F5ABAB; color: black; border: 1px solid black; border-radius: 3px; cursor: pointer; padding: 2px 2px; margin-top: 2px; width: 45px; font-size: 12px;">Locate</button>
                <div class="jp-A11yPanel-buttonContainer suggestion-header">
                    <button class="jp-text-button jp-level2 jp-GetSuggestionsButton" style="background-color: #4CAF50; color: black; border: 1px solid black; border-radius: 3px; cursor: pointer; padding: 2px 2px; margin-top: 2px; width: 120px; font-size: 12px;">Get AI Suggestions</button>
                    <span class="jp-A11yPanel-infoIcon" style="display: none;">&#9432;</span>
                    <div class="jp-A11yPanel-explanationContent jp-A11yPanel-popup" style="display: none;"></div>
                </div>
            </div>
            `;

        // Add click handler for main issue button to toggle level2 buttons
        const mainButton = buttonContainer.querySelector('.jp-MainIssueButton') as HTMLButtonElement;
        const level2Buttons = buttonContainer.querySelector('.jp-level2-buttons') as HTMLElement;
        mainButton.onclick = () => {
            level2Buttons.style.display = level2Buttons.style.display === 'none' ? 'block' : 'none';
            suggestionContainer.style.display = 'none';
        };

        // Rest of the click handlers
        const navigateButton = buttonContainer.querySelector('.jp-NavigateToCellButton') as HTMLButtonElement;
        navigateButton.onclick = () => this.navigateToCell(issue.cellIndex);

        const infoIcon = buttonContainer.querySelector('.jp-A11yPanel-infoIcon') as HTMLElement;
        infoIcon.onclick = () => {
            const popup = buttonContainer.querySelector('.jp-A11yPanel-popup') as HTMLElement;
            popup.classList.toggle('jp-A11yPanel-popup-visible');
        };

        // AI Suggestion Container UI
        const suggestionContainer = document.createElement('div');
        suggestionContainer.style.display = 'none';
        suggestionContainer.innerHTML = `
          <div class="jp-A11yPanel-suggestionContainer">
            <div class="jp-level4 jp-A11yPanel-loading" style="display: none;">
              Please wait...
            </div>
            <div class="jp-level3 jp-A11yPanel-suggestion" style="display: none;"></div>
            <button class="jp-level3 jp-text-button jp-A11yPanel-applyButton" style="display: none;">Apply</button>
          </div>
        `;

        // Add click handler for Get AI Suggestions button
        const getSuggestionsButton = buttonContainer.querySelector('.jp-GetSuggestionsButton') as HTMLButtonElement;
        getSuggestionsButton.onclick = async () => {
            suggestionContainer.style.display = 'block';
            const loadingElement = suggestionContainer.querySelector('.jp-A11yPanel-loading') as HTMLElement;
            const aiSuggestion = suggestionContainer.querySelector('.jp-A11yPanel-suggestion') as HTMLElement;
            
            const suggestionHeader = buttonContainer.querySelector('.suggestion-header') as HTMLElement;


            const explanationContent = suggestionHeader.querySelector('.jp-A11yPanel-explanationContent') as HTMLElement;
            const infoIcon = suggestionHeader.querySelector('.jp-A11yPanel-infoIcon') as HTMLElement;
            const applyButton = suggestionContainer.querySelector('.jp-A11yPanel-applyButton') as HTMLElement;
            
            // Show loading state, hide everything else
            loadingElement.style.display = 'block';
            
            try {
                const [suggestion, explanation] = await getFixSuggestions(formatPrompt(issue), this._userOllamaUrl, "mistral");
                this.suggestion = suggestion;

                if (suggestion !== 'Error') {
                    
                    // Hide loading and show results with controls
                    loadingElement.style.display = 'none';
                    aiSuggestion.style.display = 'block';
                    applyButton.style.display = 'block';
                    infoIcon.style.display = 'block';
                    
                    aiSuggestion.textContent = suggestion;
                    explanationContent.textContent = explanation;

                    // Add click handler for info icon
                    infoIcon.onclick = () => {
                        explanationContent.style.display = 
                            explanationContent.style.display === 'none' ? 'block' : 'none';
                    }
                } else {
                    loadingElement.style.display = 'none';
                    aiSuggestion.style.display = 'block';
                    aiSuggestion.textContent = 'Error getting suggestions. Please try again.';
                }
            } catch (error) {
                console.log(error);
            }
        };

        // Add click handlers for the new buttons
        const applyButton = suggestionContainer.querySelector('.jp-A11yPanel-applyButton') as HTMLElement;
        applyButton.onclick = () => {
            this.applySuggestion();
            suggestionContainer.style.display = 'none';
        };
    
        this.node.appendChild(buttonContainer);
        this.node.appendChild(suggestionContainer);
    }

    private navigateToCell(index: number): void {

        console.log(index);
        if (!this.currentNotebook) {
            console.warn('No active notebook found');
            return;
        }

        // Use the notebook panel's content directly instead of querying document
        const cells = this.currentNotebook.content.widgets;
        const targetCell = cells[index];

        if (!targetCell) {
            console.warn(`Cell at index ${index} not found`);
            return;
        }

        // Scroll the cell into view
        targetCell.node.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Highlight the cell
        targetCell.node.style.transition = 'background-color 0.5s ease';
        targetCell.node.style.backgroundColor = '#FFFFC5';

        // Remove highlight after delay
        setTimeout(() => {
            targetCell.node.style.backgroundColor = '';
        }, 2000);
    }

    private async applySuggestion(): Promise<void> {
        if (!this.currentNotebook || !this.suggestion) return;

        const cell = this.currentNotebook.content.widgets[this.cellIndex];
        if (cell && cell.model) {
            // Apply the suggestion
            cell.model.sharedModel.setSource(this.suggestion);
        }
    }
}

class A11yMainPanel extends Widget {
    private issuesContainer: HTMLElement;
    private currentNotebook: NotebookPanel | null = null;
    private _notebookTracker: INotebookTracker;
    public altCellList: AltCellList;

    constructor(notebookTracker: INotebookTracker) {
        super();
        this.addClass('jp-A11yPanel');
        this.id = 'a11y-sidebar';
        this._notebookTracker = notebookTracker;
        
        const header = document.createElement('h2');
        header.textContent = 'Accessibility Checker';
        header.className = 'jp-A11yPanel-header';
        
        const accessibilityIcon = new LabIcon({
            name: 'a11y:accessibility',
            svgstr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#154F92" d="M256 48c114.953 0 208 93.029 208 208 0 114.953-93.029 208-208 208-114.953 0-208-93.029-208-208 0-114.953 93.029-208 208-208m0-40C119.033 8 8 119.033 8 256s111.033 248 248 248 248-111.033 248-248S392.967 8 256 8zm0 56C149.961 64 64 149.961 64 256s85.961 192 192 192 192-85.961 192-192S362.039 64 256 64zm0 44c19.882 0 36 16.118 36 36s-16.118 36-36 36-36-16.118-36-36 16.118-36 36-36zm117.741 98.023c-28.712 6.779-55.511 12.748-82.14 15.807.851 101.023 12.306 123.052 25.037 155.621 3.617 9.26-.957 19.698-10.217 23.315-9.261 3.617-19.699-.957-23.316-10.217-8.705-22.308-17.086-40.636-22.261-78.549h-9.686c-5.167 37.851-13.534 56.208-22.262 78.549-3.615 9.255-14.05 13.836-23.315 10.217-9.26-3.617-13.834-14.056-10.217-23.315 12.713-32.541 24.185-54.541 25.037-155.621-26.629-3.058-53.428-9.027-82.141-15.807-8.6-2.031-13.926-10.648-11.895-19.249s10.647-13.926 19.249-11.895c96.686 22.829 124.283 22.783 220.775 0 8.599-2.03 17.218 3.294 19.249 11.895 2.029 8.601-3.297 17.219-11.897 19.249z"/></svg>'
        });

        this.title.icon = accessibilityIcon;
        this.title.caption = 'Accessibility';



        const notifWrapper = document.createElement('div');

        const notifSubWrapper = document.createElement('div');
        notifSubWrapper.style.display = 'flex';
        notifSubWrapper.style.alignItems = 'center';
        notifSubWrapper.style.flexWrap = 'nowrap';


        const cellNavNotif = document.createElement('button');
        cellNavNotif.className = "cell-nav-notif";
        cellNavNotif.classList.add("jp-toast-button");
        cellNavNotif.classList.add("jp-mod-small");
        cellNavNotif.classList.add("jp-Button");
        cellNavNotif.textContent = "NOTICE: Cell Navigation Issue";

        //dropdown box
        const dropdown = document.createElement('div');
        dropdown.className = "cell-nav-notif-dropdown";
        const dropDownText = document.createElement('p');
        dropDownText.textContent = "The jupyterlab-a11y-checker has a known cell navigation issue for Jupyterlab version 4.2.5 or later. To fix this, please navigate to 'Settings' → 'Settings Editor' → Notebook, scroll down to 'Windowing mode', and choose 'defer' from the dropdown. Please note that this option may reduce the performance of the application. For more information, please see the";
        dropDownText.style.color = "black";
        dropdown.appendChild(dropDownText);
        
        const link = document.createElement('a');
        link.href = "https://jupyter-notebook.readthedocs.io/en/stable/changelog.html";
        link.textContent = "Jupyter Notebook changelog.";
        link.style.color = "#069";
        link.style.textDecoration = "underline";
        link.target = "_blank";
        dropdown.appendChild(link);

        cellNavNotif.addEventListener('click', () => {
          dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        });

        // Dismiss button container for centering
        const dismissButtonContainer = document.createElement('div');
        dismissButtonContainer.style.display = 'flex';
        dismissButtonContainer.style.justifyContent = 'center';
        dismissButtonContainer.style.alignItems = 'center';
        dismissButtonContainer.style.width = '100%';
        dismissButtonContainer.style.marginTop = '10px';
        dismissButtonContainer.style.marginBottom = '10px';
        dismissButtonContainer.style.padding = '0 10px';

        // Dismiss button to dismiss the Navigation Issue notification
        const dismissButton = document.createElement('button');
        dismissButton.className = "cell-nav-notif-dismiss";
        dismissButton.textContent = "Dismiss";
        dismissButton.style.backgroundColor = 'black';
        dismissButton.style.color = 'white';
        dismissButton.style.border = 'none';
        dismissButton.style.borderRadius = '5px';
        dismissButton.style.cursor = 'pointer';
        dismissButton.style.padding = '8px 16px';
        dismissButton.style.minWidth = '80px';
        dismissButton.style.textAlign = 'center';

        // Remove the Navigation Issue notification on click
        dismissButton.addEventListener('click', () => {
            notifWrapper.remove();
        });

        dismissButtonContainer.appendChild(dismissButton);
        dropdown.appendChild(dismissButtonContainer);
        notifSubWrapper.appendChild(cellNavNotif);
        notifWrapper.appendChild(notifSubWrapper)
        notifWrapper.appendChild(dropdown);
        
        // Render out AI Suggested issues and solutions
        const analyzeButton = document.createElement('button');
        analyzeButton.className = 'jp-Button';
        analyzeButton.textContent = 'Analyze Notebook';
        analyzeButton.onclick = () => this.analyzeCurrentNotebook();
        
        this.issuesContainer = document.createElement('div');
        this.issuesContainer.className = 'jp-A11yPanel-issues';

        // Render out the manually detected issues
        this.altCellList = new AltCellList(notebookTracker);

        this.node.appendChild(header);
        this.node.appendChild(notifWrapper);
        this.node.appendChild(analyzeButton);
        this.node.appendChild(this.issuesContainer);
        this.node.appendChild(this.altCellList.node);

        // Initialize with current notebook if one exists
        if (notebookTracker.currentWidget) {
            this.setNotebook(notebookTracker.currentWidget);
            const content = notebookTracker.currentWidget.content;
            checkAllCells(content, this.altCellList, () => isEnabled, notebookTracker.currentWidget.context.path, true);
        }
    }

    setNotebook(notebook: NotebookPanel) {
        this.currentNotebook = notebook;
        this.altCellList.setNotebook(notebook);
    }

    private async analyzeCurrentNotebook() {
        if (!this.currentNotebook) return;
        
        this.issuesContainer.innerHTML = '';
        console.log('Analyzing current notebook');
        const issues = await analyzeCellsAccessibility(this.currentNotebook);
        if (issues.length > 0) {
            // Adding a section header and horizontal divider for AI Suggested issues
            //TO DO: condense this, repurpose addSection()
            const headerContainer = document.createElement('div');
            headerContainer.style.display = 'flex';
            headerContainer.style.alignItems = 'center';
            
            // Create section header
            const sectionHeader = document.createElement('h3');
            sectionHeader.textContent = 'AI Detected Issues';
            sectionHeader.style.margin = '15px';
            headerContainer.appendChild(sectionHeader);

            // Create Apply All button
            const applyAllButton = document.createElement('button');
            applyAllButton.textContent = "Apply All";
            applyAllButton.style.backgroundColor = '#4CAF50';
            applyAllButton.style.color = 'black';
            applyAllButton.style.borderRadius = '3px';
            applyAllButton.style.cursor = 'pointer';
            applyAllButton.style.border = '1px solid black';
            applyAllButton.style.marginLeft = '20px';
            headerContainer.appendChild(applyAllButton);

            this.issuesContainer.appendChild(headerContainer);

            // Create horizontal divider
            const horizontalDivider = document.createElement('div');
            horizontalDivider.style.width = '90%';
            horizontalDivider.style.height = '1px';
            horizontalDivider.style.backgroundColor = 'grey';
            horizontalDivider.style.marginLeft = '20px';
            horizontalDivider.style.marginRight = '30px';
            horizontalDivider.style.marginTop = '10px';
            horizontalDivider.style.marginBottom = '10px';
            this.issuesContainer.appendChild(horizontalDivider);

            console.log(issues.length);
            issues.forEach(issue => {
                console.log(issue.axeResults.map(result => result.id).join(', '));
                const issueWidget = new CellIssueWidget(issue, this.currentNotebook!, this._notebookTracker);
                this.issuesContainer.appendChild(issueWidget.node);
            });
        } else {
            console.log('No issues found');
        }
        issues.forEach(issue => {
            const issueWidget = new CellIssueWidget(issue, this.currentNotebook!, this._notebookTracker);
            this.issuesContainer.appendChild(issueWidget.node);
            // TO DO: add to errorCategoryMap under AI Suggestions
        });
    }
}

// Extension Configuration
const extension: JupyterFrontEndPlugin<void> = {
    id: 'jupyterlab-a11y-fix',
    autoStart: true,
    requires: [ILabShell, INotebookTracker],
    activate: (app: JupyterFrontEnd, labShell: ILabShell, notebookTracker: INotebookTracker) => {
        const panel = new A11yMainPanel(notebookTracker);
        
        labShell.add(panel, 'right');

        // Track panel visibility
        labShell.currentChanged.connect(() => {
            const current = labShell.currentWidget;
            if (current instanceof NotebookPanel) {
                panel.setNotebook(current);
            }
        });

        // Update current notebook when active widget change and add visibility tracking
        labShell.layoutModified.connect(() => {
            const isVisible = panel.isVisible;
            console.log('Panel visibility changed:', isVisible);
            if (isVisible) {
                console.log('Panel is now visible');
                //checkAllCells();
                //TODO
            } else {
                console.log('Panel is now hidden');
            }
        });

        notebookTracker.currentChanged.connect((sender, notebookPanel) => {
          if (!notebookPanel) return;
          
          notebookPanel.context.ready.then(() => {
            const { content } = notebookPanel;
    
            //for each existing cell, attach a content changed listener
            content.widgets.forEach(async cell => {
              attachContentChangedListener(content, panel.altCellList, cell, () => isEnabled, notebookTracker.currentWidget!.context.path);
            });
            checkAllCells(content, panel.altCellList, () => isEnabled, notebookTracker.currentWidget!.context.path, true)
    
            //every time a cell is added, attach a content listener to it
            if (content.model) {
              content.model.cells.changed.connect((sender, args) => {
                if (args.type === 'add') {
                  args.newValues.forEach(async (cellModel: ICellModel) => {
                    const cell = content.widgets.find(c => c.model.id === cellModel.id);
                    if(cell){
                      const newCell = cell as Cell
                      attachContentChangedListener(content, panel.altCellList, newCell, () => isEnabled, notebookTracker.currentWidget!.context.path);
                      await checkAllCells(content, panel.altCellList, () => isEnabled, notebookTracker.currentWidget!.context.path, true)
                    }          
                  });
                }
              });
            }
          });
        });
    }
};

// Everything below here is for Manual Error Checking
class AltCellList extends Widget {
  
  private _listCells: HTMLElement; 
  private _notebookTracker: INotebookTracker;

  _errorCategoryMap: Map<string, Map<string, HTMLElement>> = new Map(); //key is the error category (string), Map<key is cell ID, HTML itself>

  constructor(notebookTracker: INotebookTracker) {
    super();
    this._listCells = document.createElement('div');
    this._notebookTracker = notebookTracker;

    // make the side bar scrollable and visible
    this._listCells.style.maxHeight = '580px';
    this._listCells.style.overflowY = 'scroll';
    this._listCells.style.paddingRight = '10px';
    this._listCells.style.width = '100%';
    this._listCells.style.backgroundColor = 'white';
    this._listCells.style.minHeight = '100px';
    this._listCells.style.display = 'block';

    

    // initialize error groups
    this._errorCategoryMap.set("Header Errors", new Map());
    this._errorCategoryMap.set("Alt Text Errors", new Map());
    this._errorCategoryMap.set("Contrast Errors", new Map());
    this._errorCategoryMap.set("Transparency Errors", new Map());
    this._errorCategoryMap.set("AI Suggestions", new Map());


    const errorContainer = document.createElement('div');
    errorContainer.style.display = 'flex';
    errorContainer.style.alignItems = 'center';
    errorContainer.style.flexWrap = 'nowrap';


    this._listCells.appendChild(errorContainer);
    this.node.appendChild(this._listCells);
  }


  addSection(sectionName: string): void {
    const errorSection = document.createElement('div');
    errorSection.id = sectionName;

    const h1Header = document.createElement('h3');
    h1Header.textContent = sectionName;
    h1Header.style.margin = '15px';


    // Add header and apply button to the sidebar
    errorSection.appendChild(h1Header);

    const applyAllButton = document.createElement('button');
    applyAllButton.textContent = "Apply All";
    applyAllButton.style.backgroundColor = '#4CAF50';
    applyAllButton.style.color = 'black';
    applyAllButton.style.borderRadius = '3px';
    applyAllButton.style.cursor = 'pointer';
    applyAllButton.style.border = '1px solid black';

    applyAllButton.style.marginLeft = '20px';


    errorSection.appendChild(applyAllButton);


    const horizontalDivider = document.createElement('div');

    // Apply styles to make it a thin grey line
    horizontalDivider.style.width = '90%';
    horizontalDivider.style.height = '1px';
    horizontalDivider.style.backgroundColor = 'grey';
    horizontalDivider.style.marginLeft = '20px';
    horizontalDivider.style.marginRight = '30px';
    horizontalDivider.style.marginTop = '10px';
    horizontalDivider.style.marginBottom = '10px';


    errorSection.appendChild(horizontalDivider);
    

    let childrenDivs = Array.from(this._listCells.children);
    let add = true;
    for (let cell of childrenDivs) {
      if (cell.id === errorSection.id) {
        add = false; //cell already rendered, don't render again
      }
    }
    if (add) {
      this._listCells.appendChild(errorSection);

    }

  }


  //add a button that would navigate to the cell having the issue
  addCell(cellId: string, buttonContent: string): void {
    const listItemWrapper = document.createElement('div');
    listItemWrapper.id = 'cell-' + cellId + "_" + buttonContent;

    const listItem = document.createElement('div');
    listItem.style.display = 'flex';
    listItem.style.alignItems = 'center';
    listItem.style.flexWrap = 'nowrap';

    //button
    const button = document.createElement('button');
    button.classList.add("jp-text-button");
    button.classList.add("jp-level1");
    button.classList.add("jp-MainIssueButton");
    button.style.margin = '5px';
    button.style.marginRight = '5px';
    button.style.marginLeft = '7px';
    button.style.flexShrink = '1';
    button.style.backgroundColor = '#e0e0e0';
    button.textContent = buttonContent;

    //dropdown box
    const dropdown = document.createElement('div');
    dropdown.style.display = 'none';
    dropdown.style.marginLeft = '50px';
    dropdown.style.marginRight = '50px';
    dropdown.style.backgroundColor = 'white';
    dropdown.style.border = '1px solid black';
    dropdown.style.padding = '5px';
    const link = document.createElement('a');
    link.style.color = '#069';
    link.style.textDecoration = 'underline';
    const summaryText = document.createElement('p');
    if (buttonContent.includes("Transparency")){
      link.href = "https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html";
      link.textContent = "WCAG transparency guidelines";
      summaryText.textContent = "Your images do not currently meet WCAG guidelines for color transparency. Resolving this is important because not all users perceive colors in the same way. Ensuring proper color contrast and transparency will make your work more accessible to a wider audience."
    } else if(buttonContent.includes("Heading")){
      link.href = "https://www.w3.org/WAI/tutorials/page-structure/headings/";
      link.textContent = "WCAG headings guidelines";
      summaryText.textContent = "Your header structure does not adhere to WCAG guidelines for page organization. Properly structured headers are essential for communicating content hierarchy and enabling assistive technologies, like screen readers, to navigate efficiently. Improving this ensures your work is accessible to the widest possible audience."
    } else if(buttonContent.includes("Alt")){
      link.href = "https://www.w3.org/TR/WCAG20-TECHS/H37.html";
      link.textContent = "WCAG alt-text guidelines";
      summaryText.textContent = "Your images currently lack appropriate alternative text, which does not align with WCAG guidelines. Alternative text is essential for communicating the purpose of images to users who cannot see them, such as those using screen readers or when images fail to load. Adding meaningful descriptions ensures your work is accessible to everyone."
    } else if(buttonContent.includes("Contrast")){
      link.href = "https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html";
      link.textContent = "WCAG text color contrast guidelines";
      summaryText.textContent = "Your text does not currently meet WCAG guidelines for color contrast. Proper contrast is essential to ensure readability for users with visual impairments or color perception differences. Addressing this issue will make your work accessible to a broader audience."
    } else if(buttonContent.includes("h1 header")){
      link.href = "https://www.w3.org/WAI/tutorials/page-structure/headings/";
      link.textContent = "WCAG headings guidelines";
      summaryText.textContent = "Your header structure does not adhere to WCAG guidelines for page organization. Properly structured headers are essential for communicating content hierarchy and enabling assistive technologies, like screen readers, to navigate efficiently. Improving this ensures your work is accessible to the widest possible audience."
    }
    
    button.addEventListener('click', () => {
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });


    // Create a container div for all controls (input, apply, and locate)
    const controlsContainer = document.createElement('div');
    controlsContainer.style.display = 'flex';
    controlsContainer.style.flexDirection = 'column';
    controlsContainer.style.gap = '5px';
    controlsContainer.style.width = '100%';
    controlsContainer.style.padding = '5px';

    // Create input container
    const inputContainer = document.createElement('div');
    inputContainer.style.display = 'flex';
    inputContainer.style.width = '100%';

    // Create a text input field to enter header name
    const inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.placeholder = 'Enter header text';
    inputField.style.flex = '1';
    inputField.style.minWidth = '100px';
    inputField.style.padding = '5px 8px';
    inputField.style.border = '1px solid #ccc';
    inputField.style.borderRadius = '2px';
    inputField.style.boxSizing = 'border-box';

    // Create buttons container
    const buttonsContainer = document.createElement('div');
    buttonsContainer.style.display = 'flex';
    buttonsContainer.style.gap = '5px';
    buttonsContainer.style.marginTop = '5px';

    const apply = document.createElement('button');
    apply.textContent = "Apply";
    apply.style.backgroundColor = '#4CAF50';
    apply.style.color = 'black';
    apply.style.border = '1px solid black';
    apply.style.borderRadius = '3px';
    apply.style.cursor = 'pointer';
    apply.style.padding = '5px 10px';
    apply.style.flex = '1';

    const locate = document.createElement('button');
    locate.textContent = "Locate";
    locate.style.backgroundColor = '#F5ABAB';
    locate.style.color = 'black';
    locate.style.border = '1px solid black';
    locate.style.borderRadius = '3px';
    locate.style.cursor = 'pointer';
    locate.style.padding = '5px 10px';
    locate.style.flex = '1';
    locate.addEventListener('click', () => {
      this.scrollToCell(cellId);
    });

    // Assemble the containers
    inputContainer.appendChild(inputField);
    buttonsContainer.appendChild(apply);
    buttonsContainer.appendChild(locate);
    
    controlsContainer.appendChild(inputContainer);
    controlsContainer.appendChild(buttonsContainer);

    var add = true;
    //check if this error already exists in the running map, if so do not add it
    this._errorCategoryMap.forEach((cellMap, errorSectionName) => {
      cellMap.forEach((errorHTML, cellID) => {
          if (errorHTML.textContent === buttonContent) {
            add = false;

          }

        })
      })
      


    if (add) {
      listItem.appendChild(button);
      
      // Create controls container for all error types
      dropdown.appendChild(controlsContainer);
      
      if (buttonContent.includes("h1 header")) {
        // attach apply button logic: Create an <h1> tag when clicked
        apply.addEventListener('click', () => {
          const inputText = inputField.value.trim(); // Get the text input value
          if (inputText) {
            this.addMissingH1HeaderMarkdownCell(inputText);
            inputField.value = ''; // Clear the input field after applying
          } else {
            alert('Please enter header text.'); // Alert if input is empty
          }
        });
        
        // Show input field only for h1 header
        inputContainer.style.display = 'flex';
      } else {
        // Hide input field for other error types
        inputContainer.style.display = 'none';
        
        apply.addEventListener('click', () => {
          // TODO: Implement specific apply logic for each error type
        });
      }
      
      listItemWrapper.appendChild(listItem);
      listItemWrapper.appendChild(dropdown);

      let childrenDivs = Array.from(this._listCells.children);
      let add = true;
      for (let cell of childrenDivs) {
        if (cell.id === listItemWrapper.id) {
          add = false; //cell already rendered, don't render again
        }
      }
      if (add) {
        this._listCells.appendChild(listItemWrapper);
        //add to category map?

        //list item Wrapper
        //console.log("LIST ite warpper");
        //console.log(listItemWrapper);
        //console.log(listItemWrapper.id.slice(5));

        let mapId = cellId + buttonContent;
        if (buttonContent.includes("Transparency")){
          const innerMap = this._errorCategoryMap.get("Transparency Errors")!;

          // Update the inner map with the new div
          requestIdleCallback(() => {
            innerMap.set(mapId, listItemWrapper);
          });       
        } else if(buttonContent.includes("Heading")){
          const innerMap = this._errorCategoryMap.get("Header Errors")!;
          requestIdleCallback(() => {
            innerMap.set(mapId, listItemWrapper);
          });        
        } else if(buttonContent.includes("Alt")){
          const innerMap = this._errorCategoryMap.get("Alt Text Errors")!;

          requestIdleCallback(() => {
            innerMap.set(mapId, listItemWrapper);
          });          
        } else if(buttonContent.includes("Contrast")){
          const innerMap = this._errorCategoryMap.get("Contrast Errors")!;

          // Update the inner map with the new div
          requestIdleCallback(() => {
            innerMap.set(mapId, listItemWrapper);
          });         
        } else if(buttonContent.includes("h1 header")){
          const innerMap = this._errorCategoryMap.get("Header Errors")!;

          // Update the inner map with the new div
          requestIdleCallback(() => {
            innerMap.set(mapId, listItemWrapper);
          });
        }
      }
    }

    dropdown.appendChild(summaryText);
    dropdown.appendChild(link);


  }


    /**
   * Add a new markdown cell and open the sidebar for editing.
   */
  addMissingH1HeaderMarkdownCell(headerText: string) {
    const notebookPanel = this._notebookTracker.currentWidget;
    const notebook = notebookPanel!.content;

    // Create a new markdown cell
    const markdownCell = {
      cell_type: 'markdown',
      metadata: {},
      source: "# " + headerText,
      trusted: true,
    };
    notebook.model?.sharedModel.insertCell(0, markdownCell);
  }




  removeFromRender(cellId: string): void {
    this._errorCategoryMap.forEach((sectionMap) => {
      let nodeToRemove = sectionMap.get(cellId.slice(5, 40) + cellId.slice(41));
      //console.log("slice cell id");
      //console.log(nodeToRemove);
      //console.log(cellId.slice(5, 41) + cellId.slice(42));
      
      if (typeof nodeToRemove !== "undefined") { //cell doesn't exist, which should not happen
        //removechild on list cells
        //console.log("removing");

        //this._listCells.removeChild();
      }

    });
  }

  //scroll to cell once clicked
  scrollToCell(cellId: string): void {
    const notebookPanel = this._notebookTracker.currentWidget;
    const notebook = notebookPanel!.content;
    
    for (let i = 0; i < notebook.widgets.length; i++) {
      const cell = notebook.widgets[i];
      if (cell.model.id === cellId) {
        cell.node.scrollIntoView({ behavior: 'auto', block: 'center' });

        //flash the cell in a yellow color briefly when higlighted
        const originalStyle = cell.node.style.transition;
        cell.node.style.transition = 'background-color 0.5s ease';
        cell.node.style.backgroundColor = '#ffff99';
        setTimeout(() => {
          cell.node.style.backgroundColor = '';
          cell.node.style.transition = originalStyle;
        }, 800);
      }
    }
  }

  //helper safety method that only shows issues for cells that
  // are visible ONLY in the currently opened jupyterlab notebook
  showOnlyVisibleCells(): void {
    const notebookPanel = this._notebookTracker.currentWidget;
    const notebook = notebookPanel!.content;

    let exists = false;
    setTimeout(() => {
      console.log("LIST CELLS CHILDREN", this._listCells.children);

      let children = Array.from(this._listCells.children);
      for (let item of children) {
        for (let i = 0; i < notebook.widgets.length; i++) {
          let cell = notebook.widgets[i];
          if (item.id.includes(cell.model.id)) { //cell.model.id will be substring of item.id, notebook widgets have curr active cells
            exists = true; //cell does exist so no need to remove
            break;
          }

        }
        //if the current cell in listCells (which is everything that gets rendered) isn't in curr opened notebook, then remove it
        if (!exists) {
          //remove from listcells
          this.removeFromRender(item.id); //id of cell to remove from listcells
  
        }

      }
    }, 5000);

  }

  setNotebook(notebook: NotebookPanel): void {
    //to do
  }

}

async function checkAllCells(notebookContent: Notebook, altCellList: AltCellList, isEnabled: () => boolean, myPath: string, firstTime: boolean) {
  const headingsMap: Array<{headingLevel: number, myCell: Cell, heading: string }> = [];
  let h1Exists = false;

  notebookContent.widgets.forEach(async (cell: Cell) => {
    if (isEnabled()){
      if(firstTime){
        //Image transparency, contrast, and alt checking
        applyVisualIndicator(altCellList, cell, []);
        const mdCellIssues = await checkTextCellForImageWithAccessIssues(cell, myPath);
        const codeCellHasTransparency = await checkCodeCellForImageWithAccessIssues(cell, myPath);
        var issues = mdCellIssues.concat(codeCellHasTransparency);
        applyVisualIndicator(altCellList, cell, issues);
        addErrors(altCellList);
      }
      
      //header ordering checking
      if (cell.model.type === 'markdown') {
        const mCell = cell as MarkdownCell;

        const cellText = mCell.model.toJSON().source.toString();
        const markdownHeadingRegex = /^(#+) \s*(.*)$/gm;
        const htmlHeadingRegex = /<h(\d+)>(.*?)<\/h\1>/gi;

        let match;
        while ((match = markdownHeadingRegex.exec(cellText)) !== null) {
          const level = match[1].length;  // The level is determined by the number of '#'
          headingsMap.push({headingLevel: level, heading: `${match[2].trim()}`, myCell: mCell});
          if (level === 1) h1Exists = true;
        }

        while ((match = htmlHeadingRegex.exec(cellText)) !== null) {
          const level = parseInt(match[1]);  // The level is directly captured by the regex
          headingsMap.push({headingLevel: level, heading: `${match[2].trim()}`, myCell: mCell });
          if (level === 1) h1Exists = true;

        }
      }

      if (headingsMap.length > 0){
        let previousLevel = headingsMap[0].headingLevel;
        let highestLevel = previousLevel;
        const errors: Array<{myCell: Cell, current: string, expected: string}> = [];
  
        headingsMap.forEach((heading, index) => {
          if (heading.headingLevel > previousLevel + 1) {
            // If the current heading level skips more than one level
            errors.push({
              myCell: heading.myCell,
              current: `h${heading.headingLevel}`,
              expected: `h${previousLevel + 1}`
            });
          } else if (heading.headingLevel < highestLevel){
            //if the header is higher than the first ever header
            errors.push({
              myCell: heading.myCell,
              current: `h${heading.headingLevel}`,
              expected: `h${highestLevel}`
            });
          }
  
          previousLevel = heading.headingLevel;
        });
  
        errors.forEach(e => {
          //remove any issues in the heading cell which has an error before adding the heading errors
          applyVisualIndicator(altCellList, e.myCell, [])
          applyVisualIndicator(altCellList, e.myCell, ["heading " + e.current + " " + e.expected]);
        });
      }
    } else {
      applyVisualIndicator(altCellList, cell, []);

    }
  });

  if (!h1Exists) {
    const cells = notebookContent.widgets;
    
    // find the first markdown cell and apply no h1 error
    for (const cell of cells) {
      if (cell.model.type === 'markdown') {
        applyVisualIndicator(altCellList, cell, ["h1 header"]);
        break; 
      }
    }
  }

  altCellList.showOnlyVisibleCells();
}


function applyVisualIndicator(altCellList: AltCellList, cell: Cell, listIssues: string[]) {
  var indicatorId: string;
  try {
    indicatorId = 'accessibility-indicator-' + cell.model.id;
  } catch {
    return;
  }
  

  //remove all indicators (red circles) on the given cell before adding
  //a new one to remove possible duplicates
  while(document.getElementById(indicatorId)){
    document.getElementById(indicatorId)?.remove();
  }

  let applyIndic = false;

  for (let i = 0; i < listIssues.length; i++) {
    const element = document.createElement("div");
    //cases for all 4 types of errors
    if (listIssues[i].slice(0,7) == "heading") { //heading h1 h1
      altCellList._errorCategoryMap.get("Header Errors")?.set(cell.model.id + "Heading format: expecting " + listIssues[i].slice(11, 13) + ", got " + listIssues[i].slice(8, 10), element);
      applyIndic = true;
    } else if(listIssues[i].split(" ")[1] == "contrast"){
      var score = Number(listIssues[i].split(" ")[0]);
      if (score < 4.5) {
        altCellList._errorCategoryMap.get("Contrast Errors")?.set(cell.model.id + "Cell Error: Text Contrast " + listIssues[i].split(" ")[2], element);
        applyIndic = true;
      }
    } else if (listIssues[i] == "Alt") {
      altCellList._errorCategoryMap.get("Alt Text Errors")?.set(cell.model.id + "Cell Error: Missing Alt Tag", element);
      applyIndic = true;
    } else if (listIssues[i] == "h1 header") {
      altCellList._errorCategoryMap.get("Header Errors")?.set(cell.model.id + "Header format: Missing h1 header", element);
      applyIndic = true;
    } 
    else {
      var score = Number(listIssues[i].split(" ")[0]);
      if (score < 9) {
        altCellList._errorCategoryMap.get("Transparency Errors")?.set(cell.model.id + "Image Err: High Image Transparency (" + ((10-score)*10).toFixed(2) + "%)", element);
        applyIndic = true;
      }
    }
  }
  
  
  if (applyIndic) {
    //styling for the red indicator
    if (!document.getElementById(indicatorId)) {
      var indicator = document.createElement('div');
      indicator.id = indicatorId;
      indicator.style.position = 'absolute';
      indicator.style.top = '30px';
      indicator.style.left = '45px';
      indicator.style.width = '15px';
      indicator.style.height = '15px';
      indicator.style.borderRadius = '50%';
      indicator.style.backgroundColor = '#ff8080';
      cell.node.appendChild(indicator);
    }
  } else {
    //if there are no errors, then remove the indicator
    let indicator = document.getElementById(indicatorId);
    indicator?.remove();
  }
  // altCellList.showOnlyVisibleCells();
}

async function checkHtmlNoAccessIssues(htmlString: string, myPath: string, cellColor: string): Promise<string[]> {
  //Finds all possible issues within a cell while parsing it as HTML
  return new Promise(async (resolve, reject) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, "text/html");
    const images = doc.querySelectorAll("img");
  
    let accessibilityTests: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img.hasAttribute("alt") || img.getAttribute("alt") === "") {
        accessibilityTests.push("Alt");
      }
    }

    //const transparencyPromises = Array.from(images).map((img: HTMLImageElement) => getImageTransparency(img.src, myPath));
    //const transparency = await Promise.all(transparencyPromises);

    //const colorContrastPromises = Array.from(images).map((img: HTMLImageElement) => getTextContrast(img.src));
    //const colorContrast =  await Promise.all(colorContrastPromises);
  
    //accessibilityTests = [...accessibilityTests, ...transparency.map(String), ...colorContrast.map(String)];
    accessibilityTests = [...accessibilityTests];
    
    resolve(accessibilityTests);
  });
}

async function checkMDNoAccessIssues(mdString: string, myPath: string, cellColor: string): Promise<string[]> {
  //Finds all possible issues within a cell while parsing it as markdown
  return new Promise(async (resolve, reject) => {
    const imageNoAltRegex = /!\[\](\([^)]+\))/g;
    const allImagesRegex = /!\[.*?\]\((.*?)\)/g;
    let accessibilityTests: string[] = [];
  
    let match: RegExpExecArray | null;
    const imageUrls: string[] = [];
  
    while ((match = allImagesRegex.exec(mdString)) !== null) {
        const imageUrl = match[1];
        if (imageUrl) {
            imageUrls.push(imageUrl);
        }
    }
  
    if (imageNoAltRegex.test(mdString)){
      accessibilityTests.push("Alt");
    }
    
    //const transparencyPromises = Array.from(imageUrls).map((i: string) => getImageTransparency(i, myPath));
    //const transparency = await Promise.all(transparencyPromises);

    //const colorContrastPromises = Array.from(imageUrls).map((i: string) => getTextContrast(i));
    //const colorContrast = await Promise.all(colorContrastPromises);
  
    //accessibilityTests = [...accessibilityTests, ...transparency.map(String), ...colorContrast.map(String)];
    accessibilityTests = [...accessibilityTests];

  
    resolve(accessibilityTests);
  });
}


async function attachContentChangedListener(notebookContent: Notebook, altCellList: AltCellList, cell: Cell, isEnabled: () => boolean, myPath: string) {
  //for each existing cell, attach a content changed listener
  cell.model.contentChanged.connect(async (sender, args) => {
    //this checks only the headers
    await checkAllCells(notebookContent, altCellList, isEnabled, myPath, false);

    //checks for text contrast, alt tags, and transparency
    applyVisualIndicator(altCellList, cell, []);
    const mdCellIssues = await checkTextCellForImageWithAccessIssues(cell, myPath);
    const codeCellHasTransparency = await checkCodeCellForImageWithAccessIssues(cell, myPath);
    var issues = mdCellIssues.concat(codeCellHasTransparency);
    applyVisualIndicator(altCellList, cell, issues);
    addErrors(altCellList);
  });  
}

async function checkTextCellForImageWithAccessIssues(cell: Cell, myPath: string): Promise<string[]> {
  //finds all issues within a text cell by parsing it as both markdown and html
  try{
    if(cell.model.type == 'markdown'){
      cell = cell as MarkdownCell;
      const cellText = cell.model.toJSON().source.toString();
      
      const markdownNoAlt = await checkMDNoAccessIssues(cellText, myPath, document.body.style.getPropertyValue("--fill-color"));
      const htmlNoAlt = await checkHtmlNoAccessIssues(cellText, myPath, document.body.style.getPropertyValue("--fill-color"));
      var issues = htmlNoAlt.concat(markdownNoAlt)
      return issues;
    } else {
      return [];
    }
  } catch {
    return [];
  }
  
}

async function checkCodeCellForImageWithAccessIssues(cell: Cell, myPath: string): Promise<string[]> {
  //finds all issues in the output of a code cell.
  //output of a code cell is return in rendered html format,
  //so only need to check with html accessibility.
  try{
    if(cell.model.type == 'code'){
      const codeCell = cell as CodeCell;
      const outputText = codeCell.outputArea.node.outerHTML;
  
      const generatedOutputImageIssues = await checkHtmlNoAccessIssues(outputText, myPath, document.body.style.getPropertyValue("--fill-color"));
      return generatedOutputImageIssues;
    } else {
      return [];
    }
  } catch {
    return [];
  }

  
}

async function addErrors(altCellList: AltCellList) {
  for (let [sectionName, errorsMap] of altCellList._errorCategoryMap.entries()) {
    let size = errorsMap.size || 0;

    //render the section first
    if (size > 0) {
      await altCellList.addSection(sectionName); 

      // errors under a section/category type
      if (errorsMap.size > 0) {
        errorsMap.forEach((errorHTML, cellId) => {
          altCellList.addCell(cellId.slice(0, 36), cellId.slice(36)); // Takes in cell ID, button content
        });
      }
    }
  }
  console.log("Category Map");
  console.log(altCellList._errorCategoryMap);
}




export default extension;
