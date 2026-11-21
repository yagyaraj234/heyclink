# IndicVoices-R gold

Each `*.json` file holds one clip's transcript, quoted verbatim, plus our hand-reviewed grocery labels (`gold`). No audio is committed. `eval/load-indicvoices.ts` fetches the audio into `eval/data/` (gitignored).

## Attribution

Transcripts are from **IndicVoices-R** by AI4Bharat (IIT Madras), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Upstream: <https://huggingface.co/datasets/ai4bharat/indicvoices_r> and <https://github.com/AI4Bharat/IndicVoices-R>. We fetched them from the Hugging Face mirrors `SPRINGLab/IndicVoices-R_Hindi` and `SPRINGLab/IndicVoices-R_Telugu`.

> Ashwin Sankar, Srija Anand, Praveen Srinivasa Varadhan, Sherry Thomas, Mehak Singal, Shridhar Kumar, Deovrat Mehendale, Aditi Krishana, Giri Raju, Mitesh Khapra. *IndicVoices-R: Unlocking a Massive Multilingual Multi-speaker Speech Corpus for Scaling Indian TTS.* NeurIPS 2024 Datasets and Benchmarks Track.

**Changes:** we selected a subset of clips and added labels (`gold`: item id, quantity, unit, brand, advance). The transcript text is unchanged. The labels are ours. They are not part of IndicVoices-R and are not endorsed by its authors. The material is provided as-is, without warranty, per the license.
