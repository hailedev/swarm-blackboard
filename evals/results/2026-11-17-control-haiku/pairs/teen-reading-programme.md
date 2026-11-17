# A six-week teen reading programme on a $500 budget

Chosen as the swarm's widest win. Problem `teen-reading-programme`.

## Problem

A public library branch in a mid-sized town wants to run a six-week programme for 13-to-17-year-olds, most of whom do not use the library today. One librarian can give four hours a week; volunteers can be recruited; the budget is $500 for everything beyond the room and the existing collection. The branch manager will repeat the programme only if there is evidence it changed something for the participants, not just that some turned up.

Design the programme: what happens each week and why teenagers who do not read for pleasure would come, how the library reaches teens who are not already visitors, how the $500 is spent, and how the outcome is measured within the six weeks in a way that goes beyond attendance. Make sure it fits four hours of librarian time a week.

### Constraints

- A public library branch in a mid-sized town; one librarian can give four hours a week, plus volunteers if recruited.
- Budget is $500 in total for the six weeks; the library already has a meeting room and a book collection.
- The target is 13-to-17-year-olds, most of whom do not currently use the library.
- The branch manager wants evidence of the outcome, not only attendance numbers, to decide whether to repeat it.

### Success criteria

- A programme design (format, frequency, content) that a non-reading teenager would plausibly turn up to.
- A recruitment plan that reaches teens who do not use the library today.
- A budget that allocates the $500 and shows what it buys.
- Outcome measures beyond attendance, measurable within six weeks, and how they are collected.

## Swarm answer

_Run `01a1e708-c374-79a1-816a-9ed0da900538`, 12 rounds, completed/budget_rounds, $0.0165, confidence 0.62; the final write-up, asked for about 900 words, 615 written._

Recommendation: run a six-week, peer-supported Digital Creators Lab in the existing meeting room, with one librarian giving four hours a week. Teens make short games, pixel art and comics using offline, open-source tools (LibreOffice, GIMP, Piskel) pre-installed on branch workstations. No reading is required; the making and the food are the draw, so the programme does not depend on non-readers wanting books, and books and the collection appear as reference material for the projects.

Week plan (four hours per week for the librarian). Week 1 (about 4 hours): a 60-minute welcome session where teens choose a project type and form teams of three to four; a 90-minute hands-on session on the first tool; a 30-minute baseline self-efficacy questionnaire and an artifact sample taken as the Week 1 rubric reference. Weeks 2 to 5 (about 3.5 hours each): a 15-minute opening, a 2-hour making session where teams build their project with peer mentors circulating, and a 30-minute show-and-tell where teams present progress and get peer feedback. Week 6 (about 4 hours): a final showcase where each team presents to families and library staff, the Week 6 artifacts are collected, and the post self-efficacy questionnaire is completed. Teen volunteers act as peer leads after a short briefing, which protects the librarian's time for facilitation.

Recruitment: the librarian personally contacts three non-public youth channels (a Boys and Girls Club, a YMCA branch, a religious youth group) with branded digital flyers and a QR sign-up that collects parental consent, with school counsellors as a second channel. No partner is yet confirmed, so reaching non-users is unproven; securing at least one channel is the first task in week one of preparation, and the sign-up target is 15 teens. Assumption: at least one of the three channels or a school counsellor agrees to share the flyer; if none does, recruitment moves to flyers at skate parks, sports fields and the school bus stop, which costs no extra money.

Setup is handled by two vetted adult volunteers, either retired senior cardholders with background checks or a Teen Advisory Board operating under signed volunteer agreements. Assumption: background checks can be completed before week one; if they cannot, the volunteers only set up equipment and do not supervise minors. The adult-to-teen ratio is kept at no more than one adult per eight teens.

Budget ($500): $150 food (about 10 to 15 teens at $2.50 per serving of bulk snacks and juice, across six weeks; at 15 attendees this is closer to $225, so food is the line to watch); $140 for fourteen $10 gift-card milestone prizes; $110 for printing, recruitment flyers and parental consent forms; $100 contingency and USB drives for exporting projects. The lines sum to $500. If food costs rise, cut prizes first, then reduce the contingency, and keep the consent forms, since they are required.

Outcome measures beyond attendance: the primary evidence is a Week 1 and Week 6 three-point rubric (Basic, Competent, Advanced) applied by the librarian to specific artifact skills, such as layering in pixel art, variable use in a game, or panel sequencing in a comic. Each artifact is scored and the scores are compared across weeks for each teen. As a secondary measure, a short pre and post self-efficacy item set is completed in weeks 1 and 6, and the library records card sign-ups and return visits after week 6. Self-report has poor predictive validity, so the artifact rubric carries the most weight. Assumption: a second rater scores a sample of artifacts to check agreement; if no second rater is available, the rubric is reported as indicative rather than conclusive. Repeating the programme depends on whether the artifact scores rise and the card and return-visit counts move.

## Baseline answer

_claude-haiku-5-5, asked for about 900 words, used 30 of 2707 output tokens allowed under a $0.0300 cap, cost $0.0001. Board handles are shown here; the judge saw the answers with them removed._

Recommendation: run a six-week, once-weekly 

## Judgements

Swarm 86.9%, baseline 0.0%, winner swarm.

### Order 1: A = baseline, B = swarm; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| design | 3 | 3 — Answer B argues from what draws non-readers (making games, pixel art, comics; choice of project; teams; food; peer mentors; no reading required) and gives a week-by-week structure with a final showcase. | 0 — Answer A is a single truncated line ('Recommendation: run a six-week, once-weekly') with no programme content at all. |
| recruitment | 2 | 3 — Answer B targets non-public youth channels (Boys and Girls Club, YMCA, youth group, school counsellors) with a QR sign-up, uses teen peer leads, and a fallback to skate parks and sports fields, while honestly noting no partner is confirmed and reach is unproven; the hook is making things plus food, and the partner mechanism is partly speculative. | 0 — No recruitment plan or channels appear anywhere in Answer A. |
| budget | 2 | 3 — Answer B itemises food, prizes, printing, and contingency, states they sum to $500, flags food as the line to watch, gives a cut order as a fallback, and notes in-kind resources (open-source software on existing workstations, volunteers); the food arithmetic is a little loose but acknowledged. | 0 — No budget or allocation of the $500 is given in Answer A. |
| outcomes | 3 | 2 — Answer B uses a Week 1 vs Week 6 artifact rubric, pre/post self-efficacy, card sign-ups and return visits, with a second-rater check; the repeat criterion ('scores rise and card and return-visit counts move') is stated but not given numeric thresholds. | 0 — No outcome measures are proposed in Answer A, not even attendance. |
| feasibility | 2 | 2 — Answer B accounts for librarian hours per week (about 4 in Weeks 1 and 6, about 3.5 in the middle weeks) and delegates setup to volunteers and peer leads; some Week 1 hours are tight, and prep time such as recruitment outreach and rubric creation is not clearly budgeted or described as reused. | 0 — Answer A says nothing about librarian hours or volunteer effort. |
| correctness | 2 | 2 — Answer B's claims are mostly sound and candid about limits (self-report validity, unconfirmed partners, background-check assumption, ratio of one adult to eight teens); minor issues are $140 for fourteen $10 gift cards matching the figure only loosely and the Week 1 time load of a 60-minute plus 90-minute plus 30-minute session. | 0 — Nothing substantive is claimed in Answer A, so it cannot be judged sound; it fails to address the problem. |

> Answer A is an incomplete fragment with no content; Answer B is a complete, well-reasoned design that meets every success criterion.

### Order 2: A = swarm, B = baseline; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| design | 3 | 3 — Argues a Digital Creators Lab from what draws non-readers (making, choice of project, teams, food, no reading required) and gives a week-by-week outline with session lengths. | 0 — Answer B is cut off after 'run a six-week, once-weekly' and describes no programme content, weekly activities or audience reasoning. |
| recruitment | 2 | 3 — Targets non-library youth channels (Boys and Girls Club, YMCA, religious youth group, school counsellors) with a QR sign-up and a fallback to skate parks and bus stops, and uses teen peer leads, but concedes no partner is confirmed and the hook is mainly the making and food. | 0 — No recruitment plan appears in the truncated text. |
| budget | 2 | 2 — Gives a four-line breakdown summing to $500 that fits the design, with an explicit cut order if food costs rise and a note on what the $150 food line really covers, but little is said about in-kind items such as the room, workstations and open-source software. | 0 — No budget or allocation of the $500 appears in the truncated text. |
| outcomes | 3 | 3 — Uses a Week 1 vs Week 6 artifact rubric, pre/post self-efficacy, card sign-ups and return visits, with a second-rater check, and states repeat depends on rising scores and card/return-visit movement, but no numeric threshold. | 0 — No outcome measures appear in the truncated text. |
| feasibility | 2 | 2 — Accounts for hours per week against the four-hour limit and uses peer leads and vetted volunteers, but Weeks 1 and 6 run at about 4 hours with no separate prep or recruitment time counted, and prep reuse is not stressed. | 0 — No account of librarian time or volunteer effort appears in the truncated text. |
| correctness | 2 | 3 — Candidly flags that the food line at 15 attendees runs closer to $225, that recruitment is unproven, that self-report is weak, and that background checks are an assumption, though some figures are loose (14 $10 prizes = $140, mismatched with a $150 food line). | 0 — There are no substantive practical claims to assess, only an incomplete opening phrase, so nothing demonstrates soundness. |

> Answer A is a complete, specific, candid design; Answer B is truncated and addresses none of the criteria.
