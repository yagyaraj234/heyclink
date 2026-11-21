# IndicVoices gold

reviewer: agent

Each `*.json` file holds one clip's transcript, quoted verbatim, plus our grocery labels (`gold`). No audio is committed. `eval/load-indicvoices.ts` fetches the audio into `eval/data/` (gitignored).

## Review status

The labels were reviewed by an agent, **not yet by a human**. The agent labeled each clip from the human transcript alone, under the rules in `eval/review.ts` (`RULES`), then compared its labels with the `eval/prelabel.ts` drafts and settled every disagreement by those rules. It was not fully blind: it had already seen about a dozen drafts while debugging the provisional eval. `eval/RESULTS.md` lists the clips where the gold differs from the draft. When a human has checked the labels (`node eval/review.ts`, then `apply`), change the line above to `reviewer: human`.

## Attribution

All transcripts are by AI4Bharat (IIT Madras) and are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

- **Hindi** (`iv-hi-*`) is from **IndicVoices-R**. Upstream: <https://huggingface.co/datasets/ai4bharat/indicvoices_r> and <https://github.com/AI4Bharat/IndicVoices-R>. We fetched it from the mirror `SPRINGLab/IndicVoices-R_Hindi`.
  > Ashwin Sankar, Srija Anand, Praveen Srinivasa Varadhan, Sherry Thomas, Mehak Singal, Shridhar Kumar, Deovrat Mehendale, Aditi Krishana, Giri Raju, Mitesh Khapra. *IndicVoices-R: Unlocking a Massive Multilingual Multi-speaker Speech Corpus for Scaling Indian TTS.* NeurIPS 2024 Datasets and Benchmarks Track.
- **Telugu** (`iv-te-*`) is from **IndicVoices**. Upstream: <https://huggingface.co/datasets/ai4bharat/IndicVoices>. We fetched it from the mirror `eswardivi/IndicVoices` (`telugu_train`).
  > Tahir Javed, …, Mitesh M. Khapra (21 authors). *IndicVoices: Towards building an Inclusive Multilingual Speech Dataset for Indian Languages.* Findings of ACL 2024, pp. 10740–10782. <https://arxiv.org/abs/2403.01926>

The mirror cards state no license of their own, so these terms rest on the upstream CC BY 4.0. Both upstream repos require a Hugging Face login to download, but that is an access condition, not a license term.

**Changes:** we selected a subset of clips and added labels (`gold`: item id, quantity, unit, brand, advance). The transcript text is unchanged. The labels are ours. They are not part of IndicVoices or IndicVoices-R and are not endorsed by their authors. The material is provided as-is, without warranty, per the license.
