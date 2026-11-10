---
id: confidential-llm-summaries
title: Local models or an API for summarising confidential contracts
domain: technology-choice
constraints:
  - "A 20-person professional-services firm; about 300 contracts a month, 10 to 80 pages each, in English."
  - "Client agreements forbid sharing contract text with third parties unless the client has consented in writing; some clients will consent, some will not."
  - "Budget of $300 a month all-in for this capability, including hardware amortised over three years."
  - "One technically capable staff member, not a software engineer, can spend a day a week on it."
successCriteria:
  - "A recommendation (local, API, or a split) with the reasoning, including what happens for non-consenting clients."
  - "A cost model that shows the recommendation fits $300 a month, with its assumptions visible."
  - "How summary quality is checked before anyone relies on a summary."
  - "What would change the recommendation (volume, consent rates, model prices) and how the firm would notice."
rubric:
  - id: recommendation
    weight: 3
    criterion: Makes a clear recommendation that handles both consenting and non-consenting clients.
    scale: "0 = no recommendation or ignores the consent split; 1 = a recommendation that handles one group; 2 = handles both groups; 3 = handles both and explains why a split or a single choice is better for this firm."
  - id: cost
    weight: 3
    criterion: Presents a cost model with explicit assumptions (pages, tokens, model prices, hardware amortisation) that fits the budget.
    scale: "0 = no numbers; 1 = a total with no assumptions; 2 = assumptions and arithmetic that fit $300; 3 = plus the sensitivity: which assumption breaks the budget first."
  - id: privacy
    weight: 2
    criterion: States correctly what 'does not leave the firm' means for each option, including API data-retention and training terms.
    scale: "0 = privacy hand-waved; 1 = 'local is private, API is not'; 2 = distinguishes API retention/training terms and the contractual question of consent; 3 = plus the practical controls (logging, access, deletion) each option needs."
  - id: quality
    weight: 2
    criterion: Proposes a way to check summaries before they are trusted, sized for one person one day a week.
    scale: "0 = none; 1 = 'spot-check'; 2 = a sampling and review routine with a rubric; 3 = plus how results feed back into prompts or model choice."
  - id: triggers
    weight: 1
    criterion: Names what would change the recommendation and how the firm would notice.
    scale: "0 = none; 1 = vague 'revisit later'; 2 = concrete triggers (volume, consent rate, price change); 3 = triggers with the signals that reveal them."
---
A 20-person professional-services firm wants summaries of the roughly 300 contracts it receives each month, 10 to 80 pages each. Its client agreements forbid sharing contract text with third parties without written consent; the firm expects some clients to consent and others to refuse. The firm will spend at most $300 a month on this, including any hardware amortised over three years, and has one technically capable staff member, not a software engineer, who can give it a day a week.

Recommend whether the summaries should be produced by a locally run model, a hosted API, or a combination, and how non-consenting clients' contracts are handled. Show that the recommendation fits the budget with your assumptions visible, say how the firm checks that summaries are good enough to rely on, and name what would change your recommendation and how the firm would notice.
