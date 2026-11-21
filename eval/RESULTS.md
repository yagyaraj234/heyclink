# Eval results: agent-reviewed labels, not yet human-checked, n=35

Generated 2026-11-21T07:41:40.918Z. Real speech only (self-recorded cook notes + IndicVoices); no synthetic clips.

> Gold: `eval/gold/indicvoices/`, labeled by an agent from the human transcripts under the integrator's rulings (`RULES` in `eval/review.ts`). **Not yet human-checked.** Unlike the earlier drafts, these labels were not produced by our own extraction, so they don't favor harness mode.
> Transcripts quoted below: AI4Bharat IndicVoices-R (hi) and IndicVoices (te), CC BY 4.0. See `eval/gold/indicvoices/README.md`.
> STT replayed from `eval/out/stt-cache` (`--cached-only`). No STT calls were made, so te-dafb1ddf × sarvam stays an error: Sarvam rejects audio over 30 s.

No audio yet for 30 gold cases (30 recorded); they are not in this table.

- **item F1**: right item, any qty/unit. **qty+unit F1**: item + qty + unit match (g↔kg, ml↔l normalized), R / P in brackets. Micro-averaged over lines.
- **brand**: over gold lines that name a brand. **advance**: F1 over clips with an advance, then gold advances and invented (FP) advances.
- **WER**: corpus WER over clips whose reference and hypothesis share a script (n in brackets).
- **oracle** feeds the human transcript to extraction instead of STT output: the extraction ceiling. Its stt ms is ~0, so its total is extraction + plan only.
- Latency is p50 / p95 / p99 in ms. Total = audio in → actions ready (`timings.totalMs`). whisper-cpp stt includes a per-call model reload.

| provider | mode | set | lang | clips (err) | item F1 | qty+unit F1 (R / P) | brand | advance F1 (gold, FP) | WER | total ms | stt ms | extract ms | plan ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| openai | plain | indicvoices | hi | 27 (0) | 0.53 | 0.53 (50% / 57%) | 25% | – (0, 0) | 22.2% (27) | 4449 / 6528 / 6670 | 1711 / 2405 / 2629 | 2802 / 3899 / 4414 | 0 / 0 / 0 |
| openai | plain | indicvoices | te | 8 (0) | 0.80 | 0.60 (60% / 60%) | 40% | – (0, 0) | 42.0% (8) | 4099 / 6624 / 6624 | 1300 / 2455 / 2455 | 2888 / 4170 / 4170 | 0 / 0 / 0 |
| openai | harness | indicvoices | hi | 27 (0) | 0.71 | 0.71 (75% / 67%) | 75% | – (0, 0) | 20.6% (27) | 4508 / 5707 / 6713 | 1652 / 2375 / 2404 | 2797 / 3811 / 4338 | 0 / 0 / 0 |
| openai | harness | indicvoices | te | 8 (0) | 0.50 | 0.50 (40% / 67%) | 40% | – (0, 0) | 42.0% (8) | 3916 / 5009 / 5009 | 1022 / 2203 / 2203 | 2753 / 3190 / 3190 | 0 / 0 / 0 |
| sarvam | plain | indicvoices | hi | 27 (0) | 0.57 | 0.57 (50% / 67%) | 25% | – (0, 0) | 23.4% (27) | 3238 / 4300 / 9513 | 432 / 1111 / 1419 | 2699 / 3374 / 8923 | 0 / 0 / 0 |
| sarvam | plain | indicvoices | te | 8 (1) | 1.00 | 1.00 (100% / 100%) | 100% | – (0, 0) | 32.4% (7) | 3503 / 4151 / 4151 | 418 / 1149 / 1149 | 2983 / 3708 / 3708 | 0 / 0 / 0 |
| sarvam | harness | indicvoices | hi | 27 (0) | 0.88 | 0.88 (88% / 88%) | 75% | – (0, 0) | 23.2% (27) | 3310 / 4047 / 4109 | 405 / 670 / 1034 | 2786 / 3388 / 3596 | 0 / 0 / 0 |
| sarvam | harness | indicvoices | te | 8 (1) | 0.86 | 0.86 (100% / 75%) | 100% | – (0, 0) | 33.3% (7) | 3311 / 3888 / 3888 | 460 / 1045 / 1045 | 2851 / 3344 / 3344 | 0 / 0 / 0 |
| whisper-cpp | plain | indicvoices | hi | 27 (0) | 0.57 | 0.57 (50% / 67%) | 25% | – (0, 0) | 46.3% (27) | 6042 / 7913 / 8142 | 3293 / 4559 / 4748 | 2714 / 3737 / 3993 | 0 / 0 / 0 |
| whisper-cpp | plain | indicvoices | te | 8 (0) | 0.33 | 0.00 (0% / 0%) | 20% | – (0, 0) | 88.0% (8) | 15697 / 22686 / 22686 | 12902 / 19673 / 19673 | 2833 / 3505 / 3505 | 0 / 0 / 0 |
| whisper-cpp | harness | indicvoices | hi | 27 (0) | 0.74 | 0.63 (75% / 55%) | 63% | – (0, 0) | 64.2% (23) | 6139 / 7269 / 7489 | 2989 / 3634 / 3643 | 2877 / 4291 / 4853 | 0 / 0 / 0 |
| whisper-cpp | harness | indicvoices | te | 8 (0) | 0.50 | 0.00 (0% / 0%) | 20% | – (0, 0) | – | 6283 / 9096 / 9096 | 2821 / 4826 / 4826 | 2861 / 5192 / 5192 | 0 / 0 / 0 |
| oracle | plain | indicvoices | hi | 27 (0) | 0.59 | 0.59 (63% / 56%) | 50% | – (0, 0) | 0.0% (27) | 2893 / 3732 / 4072 | 0 / 0 / 0 | 2892 / 3731 / 4072 | 0 / 0 / 0 |
| oracle | plain | indicvoices | te | 8 (0) | 0.89 | 0.89 (80% / 100%) | 80% | – (0, 0) | 0.0% (8) | 2935 / 4084 / 4084 | 0 / 0 / 0 | 2935 / 4084 / 4084 | 0 / 0 / 0 |
| oracle | harness | indicvoices | hi | 27 (0) | 0.74 | 0.74 (88% / 64%) | 75% | – (0, 0) | 0.0% (27) | 2752 / 3490 / 3595 | 0 / 0 / 0 | 2752 / 3490 / 3595 | 0 / 0 / 0 |
| oracle | harness | indicvoices | te | 8 (0) | 0.91 | 0.91 (100% / 83%) | 100% | – (0, 0) | 0.0% (8) | 2855 / 3831 / 3831 | 0 / 0 / 0 | 2855 / 3831 / 3831 | 0 / 0 / 0 |

### Where the gold differs from the draft (17 of 40 clips)

| clip | draft | gold | rule |
|---|---|---|---|
| hi-072c2f4f, hi-9f4032c3, hi-fe7f8a43, te-5430e654 | no line | 0.25 kg tea (tata); 200 g biscuits (bb-popular); 100 g tea (olinda); 0.5 kg raisins (bb-royal) | a price query that names a quantity is a line |
| hi-1a282af2 | 5 packet kabuli-chana | no line | replace X with Y: Y (triphala powder) has no item id, X is never a line |
| hi-24423d76 | 1.5 l corn | no line | the same: Y is a watering can |
| hi-66868606, te-f7bdd369 | 5 kg atta (aashirvaad) | no line | repeat my last order, no item spoken. The atta was filled in from household history |
| hi-c5ad6286 | 0.25 kg detergent-powder (henko) | no line | a detergent bar is not detergent powder. Never force a near id |
| hi-02afeb0a, hi-a0db9e12, te-3cdd5b59 | brand 24-mantra-organic, tata-sampann, slurp-firm | 24-mantra, tata, slurrp-farm | brand ids from `src/indic/brands.ts` |
| hi-cooking-3b2f10ef, hi-cooking-9a9fee38 | 0.5 kg chicken; 1 kg milk | dropped | a cooking story, not an order |
| hi-cooking-ae66f29e, hi-174f5f45, te-1b8ab4c3 | no line | dropped | a cooking story or a complaint: no grocery intent |

The other 23 clips match the draft exactly. Judgment calls for the human check:
- cookies → `biscuits` (hi-9f4032c3)
- instant oats powder → `oats` (te-3cdd5b59)
- "small bags" of pasta → `packet` (te-dafb1ddf)
- brand `tata` rather than the sub-brand `tata-sampann`/`tata-tea-chakra-gold` (plain mode outputs the sub-brand)
- dropping the no-intent clips rather than keeping them as empty negatives

### Reading it (hand notes on this run)

- **n is tiny.** Hindi has 27 clips and 8 gold lines, and Telugu has 8 clips and 5 lines (4 for Sarvam). One Hindi line moves recall by about 12 points. 23 of the 35 clips have no line, so a single invented line costs a lot of precision. Advance has no gold positives, and no run invented one.
- **Harness beats plain on every provider**, now that the labels aren't harness-made. Hindi qty+unit F1: openai 0.53→0.71, sarvam 0.57→0.88, whisper-cpp 0.57→0.63, oracle 0.59→0.74. The direction is consistent, but it rests on 8 lines and one LLM sample per run.
- **The oracle row puts the remaining misses on extraction, not STT.** With perfect transcripts, extraction still:
  - drops price queries (hi-072c2f4f, hi-9f4032c3, hi-fe7f8a43);
  - forces near ids in plain mode (canola oil → olive-oil, honey → hing, detergent bar → detergent-powder, chana for the triphala replace);
  - fills in household history on "repeat my last order" (hi-66868606, oracle/harness);
  - splits "turmeric cardamom tea" into three lines (hi-fe7f8a43).

  Sarvam/harness on Hindi (0.88) beating the oracle (0.74) is noise at this n. Real STT doesn't make extraction better.
- **Same pipeline (main at 09f30a9), drafts vs this gold, Hindi qty+unit F1:** openai plain 0.74→0.53 and harness 0.76→0.71; sarvam plain 0.76→0.57 and harness 0.70→0.88; whisper-cpp plain 0.59→0.57 and harness 0.70→0.63. The drafts flattered plain mode and penalized correct price-query lines.
- **Sarvam is the fastest end to end:** p50 total is about 3.2–3.5 s against about 4.0–4.5 s for openai. Extraction (about 2.8 s p50) dominates every provider, and the oracle's total (2.75–2.9 s p50) is the floor any STT adds to. Plan is under 1 ms. Sarvam plain hi p99 of 9.5 s is a single slow extraction call.
- **whisper-cpp is not usable as configured.** Harness keywords flip its output to Latin script, so 4 of 27 hi clips and all te clips are cross-script and get no WER. On Telugu plain it loops, with stt p50 of 12.9 s. Sarvam's 30 s limit (te-dafb1ddf) still needs a batch fallback.
- **Pipeline's flagged clips:** hi-24423d76 (replace) and hi-66868606 (repeat order) now have gold by the rulings, and both are "no line". On 24423d76, only openai/harness still emits the corn (1.5 kg); the other seven runs, oracle included, are right. On 66868606, only oracle/harness fills in atta; the STT runs are right.

### Worst clips: why

| clip | cause |
|---|---|
| te-dafb1ddf | STT: the Sarvam 30 s limit errors twice, whisper te is garbage, openai/harness drops both lines. Only the oracle gets close. |
| hi-fe7f8a43, hi-9f4032c3, hi-072c2f4f | extraction: a price query that names a quantity gets no line, in every run including the oracle. |
| te-06f702d8 | STT: openai mishears మళ్ళీ, so plain emits the replaced rice and harness emits nothing. Sarvam and the oracle are exact. |
| te-3cdd5b59 | extraction: openai/harness keeps the removed green tea as a line. whisper drops the oats. |
| hi-c5ad6286, hi-1a282af2 | extraction: near ids forced (detergent-powder; chana from a replace whose Y has no id). |
| hi-a0db9e12 | brand: plain mode outputs `tata-sampann` and harness outputs `tata`. Line and qty are right everywhere. |
| hi-ac2e550c | extraction: "remove the raisins" becomes a raisins line (sarvam/harness). |


## 10 worst clips

Ranked by missed + extra lines + brand misses + advance mismatches summed over every provider × mode. Score per row is the same count for that run.

### iv-te-bigbasket-dafb1ddf (26)

Gold transcript: నా షాపింగ్ కార్టులోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామూను మరియు పది ప్యాకెట్లు బెల్లా వీటా ఆర్గానిక్ ఐలిఫ్ట్ అండర్ ఐస్ క్రీం జెల్ వెయ్యి వీటితో బాటు మూడు చిన్న సంచులో సన్‍ఫీస్ట్ ఇన్‍స్టాన్ట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి
Gold: **3 packet pasta (sunfeast); 5 kg biscuits (cremica)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 3 | నా షాపింగ్ కార్టులోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామున్ మరియు పది ప్యాకెట్ల బెల్లా విటా ఆర్గానిక్ ఐ లిఫ్ట్ అండర్ ఐస్ క్రీమ్ జెల్ వెయ్యి. వీటితో పాటు మూడు చిన్న సంచులు సన్ఫీస్ట్ ఇన్స్టంట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి. | 5 kg biscuits (britannia) |
| openai/harness | 4 | నా షాపింగ్ కార్ట్ లోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామున్ మరియు పది ప్యాకెట్లు బెల్లా విటా ఆర్గానిక్ ఐ లిఫ్ట్ అండర్ ఐస్ క్రీమ్ జెల్ వెయ్యి. వీటితో పాటు మూడు చిన్న సంచులు సన్ఫీస్ట్ ఇన్స్టంట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి. | ∅ |
| sarvam/plain | 3 | error: not in STT cache (--cached-only) | – |
| sarvam/harness | 3 | error: not in STT cache (--cached-only) | – |
| whisper-cpp/plain | 4 | నా సాపిం కాట్టు లోకి రండు అట్టపెట్పులు డిజైర్ గొలాబ జామ్ను మరియో పది పాకిత్లో బెల్లా విటా అర్గానిక ఆలిఫ్ట అండర ఆస్క్రీ� | ∅ |
| whisper-cpp/harness | 7 | naa shopping kaartu lhoki, rindu aattrapetku lho, desire, gullab jamu, mariyo, padhi, pakketlho, bella vita, organic, eye lift, under ice cream, jill, veiyye, veiyye, veiyye, veiyye, tuto baato, mūdu, shinna sanchu lho, sunfish, instant, pasta treat, ayyadu keji lho, kremika mari, classic biscuit lho, koda veiyye, | 2 packet atta (aashirvaad); 1 packet pasta; 1 packet biscuits |
| oracle/plain | 2 | నా షాపింగ్ కార్టులోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామూను మరియు పది ప్యాకెట్లు బెల్లా వీటా ఆర్గానిక్ ఐలిఫ్ట్ అండర్ ఐస్ క్రీం జెల్ వెయ్యి వీటితో బాటు మూడు చిన్న సంచులో సన్‍ఫీస్ట్ ఇన్‍స్టాన్ట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి | 5 kg biscuits (cremica) |
| oracle/harness | 0 | నా షాపింగ్ కార్టులోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామూను మరియు పది ప్యాకెట్లు బెల్లా వీటా ఆర్గానిక్ ఐలిఫ్ట్ అండర్ ఐస్ క్రీం జెల్ వెయ్యి వీటితో బాటు మూడు చిన్న సంచులో సన్‍ఫీస్ట్ ఇన్‍స్టాన్ట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి | 3 packet pasta (sunfeast); 5 kg biscuits (cremica) |

### iv-hi-bigbasket-fe7f8a43 (19)

Gold transcript: क्या सौ ग्राम ओलिंडा टर्मरिक कार्डमम टी की कीमत पाँच सौ रुपए से ज़्यादा है
Gold: **100 g tea (olinda)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 2 | क्या 100 ग्राम ओलिंडा टर्मरिक कार्डमम टी की कीमत 500 रुपये से ज्यादा है? | ∅ |
| openai/harness | 2 | क्या 100 ग्राम ऑलिंडा टर्मरिक कार्डामम टी की कीमत 500 रुपये से ज़्यादा है? | ∅ |
| sarvam/plain | 2 | क्या 100 ग्राम ओलिंडा टर्मरिक कार्डमम टी की कीमत ₹500 से ज़्यादा है? | ∅ |
| sarvam/harness | 1 | क्या 100 ग्राम ओलिंडा टर्मरिक कार्डमम टी की कीमत ₹500 से ज़्यादा है? | 100 g tea |
| whisper-cpp/plain | 2 | क्या 100 ग्राम ओलिंडा टर्मेरिक कार्डामम टी की कीमत 500 रुपए से ज्यादा है। | ∅ |
| whisper-cpp/harness | 5 | क्या 100 gram, allinda, turmeric, cardamom tea, की कीमत 500 रुपए से ज्यादा है | 100 g turmeric; 1 packet cardamom; 1 packet tea |
| oracle/plain | 2 | क्या सौ ग्राम ओलिंडा टर्मरिक कार्डमम टी की कीमत पाँच सौ रुपए से ज़्यादा है | ∅ |
| oracle/harness | 3 | क्या सौ ग्राम ओलिंडा टर्मरिक कार्डमम टी की कीमत पाँच सौ रुपए से ज़्यादा है | 100 g turmeric; 100 g cardamom; 100 g tea |

### iv-hi-bigbasket-9f4032c3 (16)

Gold transcript: क्या दो सौ ग्राम बी बी पॉप्युलर बेकरी कुकीज़ की कीमत सौ रुपये से कम है
Gold: **200 g biscuits (bb-popular)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 2 | क्या 200 ग्राम बीबी पॉपुलर बेकरी कुकीज की कीमत सौ रुपये से कम है? | ∅ |
| openai/harness | 2 | क्या 200 ग्राम बीबी पॉपुलर बेकरी कुकीज की कीमत सौ रुपये से कम है? | ∅ |
| sarvam/plain | 2 | क्या 200 ग्राम बी बी पॉप्युलर बेकरी कुकीज़ की कीमत 100 रुपये से कम है? | ∅ |
| sarvam/harness | 2 | क्या 200 ग्राम बी बी पॉप्युलर बेकरी कुकीज़ की कीमत 100 रुपये से कम है? | ∅ |
| whisper-cpp/plain | 2 | क्या 200 ग्राम बीबी पॉप्यूलर बेकरी कुकीज की कीमत 100 रुपे से कम है। | ∅ |
| whisper-cpp/harness | 2 | क्या 200 gram BB popular bakery cookies की कीमत 100 रुपे से कम है? | ∅ |
| oracle/plain | 2 | क्या दो सौ ग्राम बी बी पॉप्युलर बेकरी कुकीज़ की कीमत सौ रुपये से कम है | ∅ |
| oracle/harness | 2 | क्या दो सौ ग्राम बी बी पॉप्युलर बेकरी कुकीज़ की कीमत सौ रुपये से कम है | ∅ |

### iv-te-bigbasket-06f702d8 (10)

Gold transcript: రేపటికి డెలివరీ అవ్వవల్సిన ఆర్డర్ మళ్ళీ చేసి అందులో బోర్జస్ వేగన్ న్యాచురా రైస్ అండ్ ఆల్మాండ్‍కి బదులు ఐదు వందలు గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి
Gold: **500 g curry-leaves (fresho)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 3 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ బల్లి చేసి, అందులో బోర్చస్ వే�గర్ నేచురల్ రైస్ అండ్ ఆల్మండ్ కిబ్బుల్ ఐదు వందల గ్రాముల ఫ్రెషో కర్వేపాకు యాడ్ చేయి. | 1 packet rice (borchus-veger-natural); 1 bunch curry-leaves (fresho) |
| openai/harness | 2 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ బల్లి చేసి, అందులో బవర్చస్ వేగర్ నేచురల్ రైస్ ఆడాల్బట్ కి బదులు ఐదు వందల గ్రాముల ఫ్రెషో కర్వే పాకు యాడ్ చేయి. | ∅ |
| sarvam/plain | 0 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ మళ్ళీ చేసి, అందులో బోర్జస్ వీగన్ న్యాచురల్ రైస్ అండ్ ఆల్మండ్ కి బదులు 500 గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి. | 500 g curry-leaves (fresho) |
| sarvam/harness | 0 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ మళ్ళీ చేసి, అందులో బోర్జస్ వీగన్ న్యాచురల్ రైస్ అండ్ ఆల్మండ్ కి బదులు 500 గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి. | 500 g curry-leaves (fresho) |
| whisper-cpp/plain | 2 | రిపటికె టిలవరి ఆభవలసుర ఆడర బల్లి చేసి అద్దలో బోర్చస్ వేగన్ నాచ్రా రైస్ అడాల్పాట్ కిపతులు ఆిదు ఒదల గ్రాబుల ఫ్రశో కరువె ప | ∅ |
| whisper-cpp/harness | 3 | ripatikki delivery, avavalsi, order, balli, chaise, adlal, boarches, vegan natural rice, adalbat, keepathil, aithodal gram, fresh, karve, pakku, add, chaise | 1 kg rice |
| oracle/plain | 0 | రేపటికి డెలివరీ అవ్వవల్సిన ఆర్డర్ మళ్ళీ చేసి అందులో బోర్జస్ వేగన్ న్యాచురా రైస్ అండ్ ఆల్మాండ్‍కి బదులు ఐదు వందలు గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి | 500 g curry-leaves (fresho) |
| oracle/harness | 0 | రేపటికి డెలివరీ అవ్వవల్సిన ఆర్డర్ మళ్ళీ చేసి అందులో బోర్జస్ వేగన్ న్యాచురా రైస్ అండ్ ఆల్మాండ్‍కి బదులు ఐదు వందలు గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి | 500 g curry-leaves (fresho) |

### iv-hi-bigbasket-072c2f4f (9)

Gold transcript: क्या जीरो दशमलव दो पाँच किलो टाटा टी चक्र गोल्ड टी की कीमत दो सौ रुपए से ज़्यादा है
Gold: **0.25 kg tea (tata)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 2 | क्या जीरो दशमलव दो पाँच किलो टाटा टी चक्र गोल्ड टी की कीमत 200 रुपये से ज़्यादा है? | ∅ |
| openai/harness | 0 | क्या जीरो दशमलव दो पाँच किलो टाटा टी चक्र गोल्ड टी की कीमत दो सौ रुपये से ज़्यादा है। | 0.25 kg tea (tata) |
| sarvam/plain | 2 | क्या 0.25 किलो टाटा टी चक्र गोल्ड टी की कीमत 200 रुपये से ज़्यादा है? | ∅ |
| sarvam/harness | 0 | क्या 0.25 किलो टाटा टी चक्र गोल्ड टी की कीमत 200 रुपये से ज़्यादा है? | 0.25 kg tea (tata) |
| whisper-cpp/plain | 2 | क्या 0.25 किलो टाटा टी चक्र गुरोल्ड टी की कीमत 200 रुपय से जादा है | ∅ |
| whisper-cpp/harness | 1 | क्या 0.25 kg, tatati, chakra gold tea की कीमत 200 रुपय से जादा है | 0.25 kg tea (chakra-gold) |
| oracle/plain | 2 | क्या जीरो दशमलव दो पाँच किलो टाटा टी चक्र गोल्ड टी की कीमत दो सौ रुपए से ज़्यादा है | ∅ |
| oracle/harness | 0 | क्या जीरो दशमलव दो पाँच किलो टाटा टी चक्र गोल्ड टी की कीमत दो सौ रुपए से ज़्यादा है | 0.25 kg tea (tata) |

### iv-te-bigbasket-3cdd5b59 (7)

Gold transcript: నా కార్టులో విన్‍గ్రీన్ ఫామ్ కెమొమాయిల్ పూలు గల గ్రీన్ టీ తీసివేసి దానికి బదులు వెయ్యి గ్రాముల స్లర్ప్ ఫర్మ్ ఇంస్టంట్ ఓట్స్ పౌడర్ వేయి
Gold: **1000 g oats (slurrp-farm)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | నా కార్డ్లో విన్గ్రీన్ ఫామ్ కిమోమైల్ పూల్గల గ్రీన్ టీ, టీసీ వేసి దాని బదులు వెయ్యి గ్రాముల స్లర్ఫమ్ ఇన్స్టాంట్ ఓట్స్ పౌడర్ వేయి. | 1000 g oats (slurfarm) |
| openai/harness | 1 | నా కార్డ్లో విన్గ్రీన్ ఫామ్ కెమోమైల్ పూలగల గ్రీన్ టీ, టీసీ వేసి దాని బదులు వెయ్యి గ్రాముల స్లర్ఫమ్ ఇన్స్టంట్ ఓట్స్ పౌడర్ వేయి. | 1 packet tea (wingreen-farm); 1000 g oats (slurrp-farm) |
| sarvam/plain | 0 | నా కార్టులో విన్ గ్రీన్ ఫామ్ కెమోమైల్ పూలు గల గ్రీన్ టీ తీసివేసి, దాని బదులు 1000 గ్రాముల స్లర్ప్ ఫామ్ ఇన్స్టంట్ ఓట్స్ పౌడర్ వేయి. | 1000 g oats (slurrp-farm) |
| sarvam/harness | 0 | నా కార్టులో విన్ గ్రీన్ ఫామ్ కెమోమైల్ పూలు గల గ్రీన్ టీ తీసివేసి, దాని బదులు 1000 గ్రాముల స్లర్ప్ ఫామ్ ఇన్స్టంట్ ఓట్స్ పౌడర్ వేయి. | 1000 g oats (slurrp-farm) |
| whisper-cpp/plain | 2 | నా కాడ్లో విన్ గ్రిం ఫామ్ కిమో మయిల్ పూల్ గ్రింటి తీసి వేసి దాని బదలు వైయి గ్రామ్ల స్లర్ఫామ్ ఇంస్టాంస్ పోడర్ వైయి | ∅ |
| whisper-cpp/harness | 3 | na kardlo, wind green farm, keemomail, poolgala green tea, tc vese, dhani badalu, vei yi gramla, slurp farm, instant oats powder vei | 1 packet tea |
| oracle/plain | 0 | నా కార్టులో విన్‍గ్రీన్ ఫామ్ కెమొమాయిల్ పూలు గల గ్రీన్ టీ తీసివేసి దానికి బదులు వెయ్యి గ్రాముల స్లర్ప్ ఫర్మ్ ఇంస్టంట్ ఓట్స్ పౌడర్ వేయి | 1000 g oats (slurrp-farm) |
| oracle/harness | 0 | నా కార్టులో విన్‍గ్రీన్ ఫామ్ కెమొమాయిల్ పూలు గల గ్రీన్ టీ తీసివేసి దానికి బదులు వెయ్యి గ్రాముల స్లర్ప్ ఫర్మ్ ఇంస్టంట్ ఓట్స్ పౌడర్ వేయి | 1000 g oats (slurrp-farm) |

### iv-hi-bigbasket-c5ad6286 (5)

Gold transcript: मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हेंको डिटर्जेंट बार जोड़ें
Gold: **∅**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हैंगो डिटर्जेंट बार जोड़ें। | 0.25 kg detergent-powder (hango) |
| openai/harness | 1 | मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हैंगो डिटर्जेंट बार जोड़ें। | 0.25 kg detergent-powder (henko) |
| sarvam/plain | 1 | मेरी आइटम सूची में 0.25 किलो हैंको डिटर्जेंट बार जोड़ें। | 0.25 kg detergent-powder (hanko) |
| sarvam/harness | 0 | मेरी आइटम सूची में 0.25 किलो हैंको डिटर्जेंट बार जोड़ें। | ∅ |
| whisper-cpp/plain | 0 | मेरी आइटम सूची में 0.25 किलो हैंको डिटरजिन बार जोडें। | ∅ |
| whisper-cpp/harness | 0 | میری item सूची में 0.25 kg hanko detergent bar जोडे | ∅ |
| oracle/plain | 1 | मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हेंको डिटर्जेंट बार जोड़ें | 0.25 kg detergent-powder (henko) |
| oracle/harness | 1 | मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हेंको डिटर्जेंट बार जोड़ें | 0.25 kg detergent-powder (henko) |

### iv-hi-bigbasket-1a282af2 (4)

Gold transcript: मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें
Gold: **∅**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 0 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | ∅ |
| openai/harness | 1 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | 5 packet kabuli-chana (naturaland-organics) |
| sarvam/plain | 0 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को 5 पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | ∅ |
| sarvam/harness | 0 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को 5 पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | ∅ |
| whisper-cpp/plain | 1 | मेरे उत्पाद के ओर्डर नेचर लेंड ओर्गैनिक्स होल चना को पांच पैकेट आर्रे ओर्गैनिक त्रीफला पाउडर से बदलें | 5 packet kala-chana (natureland-organics) |
| whisper-cpp/harness | 1 | मेरे उत्पाद के order, nature land, organics, whole chana ko, 5 packet, rray, organic, trifola powder से बदले | 5 packet kala-chana (nature-land-organics) |
| oracle/plain | 1 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें | 5 packet kala-chana (naturaland-organics) |
| oracle/harness | 0 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें | ∅ |

### iv-hi-bigbasket-a0db9e12 (4)

Gold transcript: मेरी शॉपिंग आइटम सूची में तीन पैक मोर्टीन रैट किलर केक दस किलो फ्रेश एवोकाडो और पाँच पाउच टाटा संपन्न मूँग दाल जोड़ें
Gold: **5 packet moong-dal (tata)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | मेरी शॉपिंग आइटम सूची में तीन पैक मॉर्टिन रेड किलर केक, दस किलो फ्रेश एवोकाडो और पाँच पाउच टाटा संपन्न मूंग दाल जोड़ें। | 5 packet moong-dal (tata-sampann) |
| openai/harness | 0 | मेरी शॉपिंग आइटम सूची में तीन पैक मॉर्टिन रैट किलर केक, दस किलो फ्रेश एवोकाडो और पाँच पाउच टाटा सम्पन्न मूंग दाल जोड़ें। | 5 packet moong-dal (tata) |
| sarvam/plain | 1 | मेरी शॉपिंग आइटम सूची में 3 पैक मोर्टिन रेड किलर केक, 10 किलो फ्रेश एवोकाडो और 5 पाउच टाटा संपन्न मूंग दाल जोड़ें। | 5 packet moong-dal (tata-sampann) |
| sarvam/harness | 0 | मेरी शॉपिंग आइटम सूची में 3 पैक मोर्टिन रेड किलर केक, 10 किलो फ्रेश एवोकाडो और 5 पाउच टाटा संपन्न मूंग दाल जोड़ें। | 5 packet moong-dal (tata) |
| whisper-cpp/plain | 1 | मेरी शॉपिंग आइटम सूची में तीन पैक मॉटीन रेट किलर केक, दस किलो फ्रेश एवोकाडो और पाच पाउच टाटा संपन मूंग दाल जोडें। | 5 packet moong-dal (tata-sampann) |
| whisper-cpp/harness | 0 | मेरी shopping item सूची में 3 pak मौटीन रेट किलर केक 10 किलो फ्रेश एवोकाडो और 5 पाउच टाटा संपन मूंग दाल जोडें | 5 packet moong-dal (tata) |
| oracle/plain | 1 | मेरी शॉपिंग आइटम सूची में तीन पैक मोर्टीन रैट किलर केक दस किलो फ्रेश एवोकाडो और पाँच पाउच टाटा संपन्न मूँग दाल जोड़ें | 5 packet moong-dal (tata-sampann) |
| oracle/harness | 0 | मेरी शॉपिंग आइटम सूची में तीन पैक मोर्टीन रैट किलर केक दस किलो फ्रेश एवोकाडो और पाँच पाउच टाटा संपन्न मूँग दाल जोड़ें | 5 packet moong-dal (tata) |

### iv-hi-bigbasket-ac2e550c (4)

Gold transcript: फेंकिलोमोन रेक्टोगुलर एडिसिवर हुक्स और बी बी रॉयल किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ट का कुल बिल दिखाएँ
Gold: **∅**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | ट्रैंकिलोमोन, रेक्टोगुलर एडहेसिवर हुक्स और बीबी रॉयल किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ड का कुल बिल दिखाएं। | 1 packet raisins (bb-royal) |
| openai/harness | 0 | ट्रैंकिलोमोन, रेक्टोगुलर एडहेसिव हुक्स और बीबी रॉयल किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ड का कुल बिल दिखाएँ। | ∅ |
| sarvam/plain | 1 | फैंकेलमोन रेक्टोगुलर एडहेसिव हुक्स और बी बी रॉयल किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ट का कुल बिल दिखाएँ। | 1 packet raisins (bb-royal) |
| sarvam/harness | 1 | फ्रैंकलॉमन रेक्टोगुलर एडहेसिव हुक्स और बी बी रॉयल किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ट का कुल बिल दिखाएँ। | 1 packet raisins (bb-royal) |
| whisper-cpp/plain | 0 | फैंकेलोमोन, रेक्टोगुलर, एडी, सीवर, हुक्स और बीबी, रोयल, किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ड का कुल बिल दिखाएं | ∅ |
| whisper-cpp/harness | 1 | Frenkelomon, Rectogular, Eddie, Seaver, Hooks, or BB, Royal, kishmish, htane ke baad, mujhe, mayre, shopping card ka, kul bil, dikhaen | 1 packet raisins |
| oracle/plain | 0 | फेंकिलोमोन रेक्टोगुलर एडिसिवर हुक्स और बी बी रॉयल किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ट का कुल बिल दिखाएँ | ∅ |
| oracle/harness | 0 | फेंकिलोमोन रेक्टोगुलर एडिसिवर हुक्स और बी बी रॉयल किशमिश हटाने के बाद मुझे मेरे शॉपिंग कार्ट का कुल बिल दिखाएँ | ∅ |
