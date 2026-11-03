# The ticket search narrows within the operator's JQL, joined with AND

Date: 2026-11-03

The operator wants to search among the tickets a JQL finds (a sprint, a label, a status) and
still type a key, a project key or words as before. The JQL is a second field above the search,
shown by a "Within JQL" switch beside the block's label, not a syntax in the first one: the first field already reads a key, a project key and words, and
JQL typed into it could not be told from words. Both go to `/api/jira/search` (`q` and `jql`),
and the service makes one query: the operator's condition in brackets, so its `OR` stays inside,
`AND` the condition of what was typed. The JQL's own `ORDER BY` is split off first (outside
quoted text only) and put at the end; without one the order is the latest updated first, as
before. An empty first field lists the JQL's tickets.

The JQL is applied on Enter or Apply, not on each keystroke as the first field is: a JQL half
typed is one Jira refuses, and the field would be red while it is written. The switch, not a
button, turns it on and off: a button beside the field read as one that submits the ticket, and
did not say whether the JQL was in force; switched off, the JQL is kept but not used. Both are
kept in the browser's local storage, like the folded state sources, and so is what is typed in
the search field: a reload makes the search again and shows its first page, as it was. None of
it is in the service: it is one
operator's view, not the pipeline's state, and two browsers may search within different ones.

Jira's `/search/jql` refuses a JQL it cannot parse with a 400 and its messages, which the search
returns as `invalid`, apart from `unavailable`, so a typo is not shown as an outage. A field or a
value it does not know (`stauts = Open`, `project = NOPE`) is not refused there: it is a
condition nothing meets, an empty answer. So when a JQL finds nothing on its first page the
service asks `/jql/parse?validation=strict` for the JQL alone, and its errors make the answer
`invalid`; a JQL that finds tickets is not checked again. A key typed within a JQL is a 400 when
Jira does not know the key; only a message naming the key reads as "nothing found".
