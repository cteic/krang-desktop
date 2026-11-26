//! Moving a tab among its neighbours.

/// Moves the item at `from` to `to`, and returns where the active item is
/// afterwards. An index past the end does nothing.
pub fn reorder<T>(items: &mut Vec<T>, active: usize, from: usize, to: usize) -> usize {
    if from >= items.len() || to >= items.len() || from == to {
        return active;
    }
    let item = items.remove(from);
    items.insert(to, item);
    if active == from {
        to
    } else if from < active && active <= to {
        active - 1
    } else if to <= active && active < from {
        active + 1
    } else {
        active
    }
}

/// The place one step left or right of `index`, or `None` at the edge.
pub fn neighbour(count: usize, index: usize, by: i32) -> Option<usize> {
    let target = index as i64 + i64::from(by);
    (0..count as i64)
        .contains(&target)
        .then_some(target as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_active_tab_stays_the_same_tab_when_tabs_move() {
        let letters = || vec!['a', 'b', 'c', 'd'];
        for active in 0..4 {
            for from in 0..4 {
                for to in 0..4 {
                    let mut tabs = letters();
                    let moved = letters()[from];
                    let was = letters()[active];
                    let now = reorder(&mut tabs, active, from, to);
                    assert_eq!(tabs[now], was, "{active} {from} {to}");
                    assert_eq!(tabs[to], moved, "{active} {from} {to}");
                }
            }
        }
    }

    #[test]
    fn a_move_past_the_end_does_nothing() {
        let mut tabs = vec![1, 2];
        assert_eq!(reorder(&mut tabs, 1, 0, 5), 1);
        assert_eq!(tabs, [1, 2]);
        assert_eq!(neighbour(2, 0, -1), None);
        assert_eq!(neighbour(2, 0, 1), Some(1));
        assert_eq!(neighbour(2, 1, 1), None);
    }
}
