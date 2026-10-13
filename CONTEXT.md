# Hunk Review

Hunk presents changesets as a review stream with decisions attached to review units. Its domain distinguishes the content available for understanding a change from the targets eligible for review.

## Language

**Review stream**:
An ordered sequence of file diffs presented for review.

**Review unit**:
A hunk, or an individual changed row when reviewing at line granularity, to which a review decision applies.

**Whole-file mode**:
A full-context diff containing unchanged lines, additions, and deletions, including decided review units.
_Avoid_: File view, resulting-file view

**Hunk state**:
The decision state of a review unit: undecided, accepted, rejected, or fixed.

**Hunk-state filter**:
The set of hunk states included for review. In whole-file mode it describes review eligibility rather than content visibility; in folded mode it also describes visibility.

**Eligible review unit**:
A review unit whose hunk state is included by the active hunk-state filter.

**Review cursor**:
The current position in visible diff content, which can include unchanged lines and ineligible review units.

**Review target**:
An eligible review unit addressed by an individual decision action. A cursor position need not have a review target.
