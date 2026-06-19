/// Deterministic channel assignment from job_id.
/// Jenkins one-at-a-time hash → modulo channel list.
pub fn pick_channel(job_id: &str, channels: &[String]) -> Option<String> {
    if channels.is_empty() {
        return None;
    }
    let hash = job_id.bytes().fold(0u64, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(b as u64)
    });
    Some(channels[hash as usize % channels.len()].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pick_channel_deterministic() {
        let channels = vec!["a".into(), "b".into(), "c".into()];
        let got = pick_channel("job-123", &channels);
        assert_eq!(got, pick_channel("job-123", &channels));
    }

    #[test]
    fn test_pick_channel_empty() {
        assert_eq!(pick_channel("x", &[]), None);
    }

    #[test]
    fn test_pick_channel_single() {
        let channels = vec!["only".into()];
        assert_eq!(pick_channel("anything", &channels), Some("only".into()));
    }

    #[test]
    fn test_pick_channel_distributes() {
        let channels: Vec<String> = (0..5).map(|i| i.to_string()).collect();
        let mut seen = std::collections::HashSet::new();
        for i in 0..100 {
            let c = pick_channel(&format!("job-{}", i), &channels).unwrap();
            seen.insert(c);
        }
        // With 5 channels and 100 jobs, should hit all 5
        assert_eq!(seen.len(), 5);
    }
}
