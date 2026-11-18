//! A folder as a tree: listing directories one at a time, the rows that are
//! open, what kind each file is, and what git says has changed.

pub mod git;
pub mod kind;
pub mod tree;
