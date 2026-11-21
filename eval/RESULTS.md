# PROVISIONAL: draft labels, n=40

Generated 2026-11-21T06:55:46.192Z. Real speech only (self-recorded cook notes + IndicVoices); no synthetic clips.

> IndicVoices gold read from `eval/data/indicvoices/drafts`: unreviewed drafts that `eval/prelabel.ts` produced by running our own harness extraction on the human transcript.
> So extraction F1 here is partly circular: it mostly measures how well extraction survives STT errors, not whether it's correct. Rerun against reviewed `eval/gold/indicvoices/` before quoting.
> WER is not provisional: its reference is the human IndicVoices transcript.
> Transcripts quoted below: SPRINGLab/IndicVoices-R, CC-BY-4.0.

No audio yet for 30 gold cases (30 recorded); they are not in this table.

- **item F1**: right item, any qty/unit. **qty+unit F1**: item + qty + unit match (g↔kg, ml↔l normalized), R / P in brackets. Micro-averaged over lines.
- **brand**: over gold lines that name a brand. **advance**: F1 over clips with an advance, then gold advances and invented (FP) advances.
- **WER**: corpus WER over clips whose reference and hypothesis share a script (n in brackets).
- Latency is p50 / p95 / p99 in ms. Total = audio in → actions ready (`timings.totalMs`). whisper-cpp stt includes a per-call model reload.

| provider | mode | set | lang | clips (err) | item F1 | qty+unit F1 (R / P) | brand | advance F1 (gold, FP) | WER | total ms | stt ms | extract ms | plan ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| openai | plain | indicvoices | hi | 31 (0) | 0.78 | 0.78 (82% / 75%) | 67% | – (0, 0) | 20.4% (31) | 4429 / 5812 / 6451 | 1712 / 2407 / 2630 | 2665 / 3821 / 4267 | 0 / 0 / 0 |
| openai | plain | indicvoices | te | 9 (0) | 0.73 | 0.55 (60% / 50%) | 60% | – (0, 0) | 40.7% (9) | 4046 / 6372 / 6372 | 1384 / 2456 / 2456 | 2745 / 3916 / 3916 | 0 / 0 / 0 |
| openai | harness | indicvoices | hi | 31 (0) | 0.86 | 0.86 (82% / 90%) | 67% | – (0, 0) | 19.1% (31) | 4249 / 5908 / 6153 | 1612 / 2406 / 2419 | 2653 / 3557 / 3777 | 0 / 0 / 0 |
| openai | harness | indicvoices | te | 9 (0) | 0.67 | 0.67 (60% / 75%) | 40% | – (0, 0) | 41.4% (9) | 4424 / 6267 / 6267 | 1437 / 2205 / 2205 | 2991 / 5011 / 5011 | 0 / 0 / 0 |
| sarvam | plain | indicvoices | hi | 31 (0) | 0.80 | 0.80 (73% / 89%) | 67% | – (0, 0) | 21.6% (31) | 3138 / 4223 / 4538 | 443 / 1112 / 1421 | 2595 / 3409 / 3632 | 0 / 0 / 0 |
| sarvam | plain | indicvoices | te | 9 (1) | 0.67 | 0.67 (67% / 67%) | 33% | – (0, 0) | 34.1% (8) | 2989 / 4192 / 4192 | 362 / 1151 / 1151 | 2633 / 3041 / 3041 | 0 / 0 / 0 |
| sarvam | harness | indicvoices | hi | 31 (0) | 1.00 | 0.91 (91% / 91%) | 67% | – (0, 0) | 21.4% (31) | 3042 / 4495 / 4514 | 400 / 672 / 1035 | 2695 / 3548 / 3823 | 0 / 0 / 0 |
| sarvam | harness | indicvoices | te | 9 (1) | 0.67 | 0.67 (67% / 67%) | 33% | – (0, 0) | 35.0% (8) | 3156 / 3852 / 3852 | 447 / 1046 / 1046 | 2806 / 3013 / 3013 | 0 / 0 / 0 |
| whisper-cpp | plain | indicvoices | hi | 31 (0) | 0.60 | 0.60 (55% / 67%) | 56% | – (0, 0) | 42.2% (31) | 6179 / 8142 / 8158 | 3294 / 4560 / 4749 | 2687 / 3943 / 4365 | 0 / 0 / 0 |
| whisper-cpp | plain | indicvoices | te | 9 (0) | 0.00 | 0.00 (0% / 0%) | 0% | – (0, 0) | 85.8% (9) | 16340 / 22794 / 22794 | 12903 / 19674 / 19674 | 3192 / 3517 / 3517 | 0 / 0 / 0 |
| whisper-cpp | harness | indicvoices | hi | 31 (0) | 0.64 | 0.64 (64% / 64%) | 44% | – (0, 0) | 58.5% (26) | 5843 / 7193 / 7669 | 2990 / 3772 / 4490 | 2779 / 3769 / 4025 | 0 / 0 / 0 |
| whisper-cpp | harness | indicvoices | te | 9 (0) | 0.46 | 0.00 (0% / 0%) | 0% | – (0, 0) | – | 5615 / 9696 / 9696 | 3119 / 4827 / 4827 | 2646 / 5791 / 5791 | 0 / 0 / 0 |

### Reading it (hand notes on this run)

- **n is tiny.** Gold lines: hi 11 (9 branded), te 5 (sarvam te 3, because one clip errored). Each hi line is about 9 points of recall. 25 of the 40 drafts have no grocery line at all (price queries, "repeat order", products not in `fixtures/items.json`), so precision on those clips counts for a lot. Advance has 0 gold positives, so its F1 is undefined; nothing invented an advance (FP 0 everywhere).
- **Harness vs plain is confounded.** The drafts were made in harness mode (resolver ids, quantity normalizer, household context), so harness runs earn credit just for matching them. That shows as qty+unit F1 0.78→0.86 (openai) and 0.80→0.91 (sarvam), but it is not evidence that harness is better until gold is reviewed. With 11 lines and one LLM sample per config, a single line moves F1 by about 0.09.
- **Sarvam is the fastest end to end.** p50 total is about 3.0 s against 4.2–4.4 s for openai, because STT is about 0.4 s against 1.6 s. Extraction (about 2.7 s p50) dominates every provider. Plan is under 1 ms.
- **whisper-cpp is not usable as configured.** Its harness mode passes roman keywords as `--prompt`, which flips output to Latin script: WER is cross-script on 5/31 hi and 9/9 te clips. On te plain it loops: stt p50 is 12.9 s and the output is truncated mid-codepoint (`�`).
- **Sarvam rejects audio over 30 s** (`iv-te-bigbasket-dafb1ddf`): "use the batch API". The adapter needs a fallback or chunking.

### Worst clips: label problem or pipeline problem?

| clip | verdict | why |
|---|---|---|
| te-dafb1ddf | pipeline (STT) | sarvam 30 s limit; whisper te garbage. openai is perfect. |
| hi-24423d76 | **draft wrong** | "replace X with 1.5 l watering can": the 1.5 l belongs to the can, not the corn. Also no rule for replace intents. |
| te-f7bdd369, hi-66868606 | **draft questionable** | "repeat my last order": the draft filled in the household's last order (5 kg atta). Decide whether that is wanted before scoring it. |
| te-06f702d8 | pipeline (STT) | openai mishears మళ్ళీ→బల్లి and drops the line; sarvam is exact. |
| te-3cdd5b59 | brand slugs | gold `slurp-firm` vs pred `slurrp-farm`/`slurfm`: brand slugs aren't canonical, so the brand metric is noisy. |
| hi-1a282af2 | **draft questionable** | a replace intent again: the 5 packets are the triphala replacement, not the chana. Also kala-chana vs kabuli-chana from whisper. |
| te-5430e654 | **extraction** | a price query ("…ధర ఎంత") gets extracted as a 0.5 kg raisins order by every provider. |
| hi-08eeb3eb | **extraction** | "chizzpa potato chips" maps to `cheese` (openai/plain+harness). It should be dropped as unknown. |
| hi-c5ad6286 | **extraction** | harness drops the brand `henko` that plain mode keeps (sarvam), and whisper gives `hanko` (not fuzzy-matched). |

## 10 worst clips

Ranked by missed + extra lines + brand misses + advance mismatches summed over every provider × mode. Score per row is the same count for that run.

### iv-te-bigbasket-dafb1ddf (18)

Gold transcript: నా షాపింగ్ కార్టులోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామూను మరియు పది ప్యాకెట్లు బెల్లా వీటా ఆర్గానిక్ ఐలిఫ్ట్ అండర్ ఐస్ క్రీం జెల్ వెయ్యి వీటితో బాటు మూడు చిన్న సంచులో సన్‍ఫీస్ట్ ఇన్‍స్టాన్ట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి
Gold: **3 packet pasta (sunfeast); 5 kg biscuits (cremica)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 0 | నా షాపింగ్ కార్టులోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామున్ మరియు పది ప్యాకెట్ల బెల్లా విటా ఆర్గానిక్ ఐ లిఫ్ట్ అండర్ ఐస్ క్రీమ్ జెల్ వెయ్యి. వీటితో పాటు మూడు చిన్న సంచులు సన్ఫీస్ట్ ఇన్స్టంట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి. | 3 packet pasta (sunfeast); 5 kg biscuits (cremica) |
| openai/harness | 0 | నా షాపింగ్ కార్ట్ లోకి రెండు అట్టపెట్టెలు డిజైర్ గులాబ్ జామున్ మరియు పది ప్యాకెట్లు బెల్లా విటా ఆర్గానిక్ ఐ లిఫ్ట్ అండర్ ఐస్ క్రీమ్ జెల్ వెయ్యి. వీటితో పాటు మూడు చిన్న సంచులు సన్ఫీస్ట్ ఇన్స్టంట్ పాస్తా ట్రీట్ ఐదు కేజీల క్రెమికా మారీ క్లాసిక్ బిస్కెట్లు కూడా వెయ్యి. | 3 packet pasta (sunfeast); 5 kg biscuits (cremica) |
| sarvam/plain | 3 | error: sarvam stt 400: {"error":{"message":"Audio duration exceeds the maximum limit of 30 seconds. Please use the batch API for longer audio files.","code":"invalid_request_error","request_id":"20261121_5ec8c281-a6a8-4c28-be6a-776d1d737317"}} | – |
| sarvam/harness | 3 | error: sarvam stt 400: {"error":{"message":"Audio duration exceeds the maximum limit of 30 seconds. Please use the batch API for longer audio files.","code":"invalid_request_error","request_id":"20261121_4cce95a3-2042-4208-8168-6aa200d3356a"}} | – |
| whisper-cpp/plain | 5 | నా సాపిం కాట్టు లోకి రండు అట్టపెట్పులు డిజైర్ గొలాబ జామ్ను మరియో పది పాకిత్లో బెల్లా విటా అర్గానిక ఆలిఫ్ట అండర ఆస్క్రీ� | 10 packet olive-oil (bella-vita) |
| whisper-cpp/harness | 7 | naa shopping kaartu lhoki, rindu aattrapetku lho, desire, gullab jamu, mariyo, padhi, pakketlho, bella vita, organic, eye lift, under ice cream, jill, veiyye, veiyye, veiyye, veiyye, tuto baato, mūdu, shinna sanchu lho, sunfish, instant, pasta treat, ayyadu keji lho, kremika mari, classic biscuit lho, koda veiyye, | 2 packet atta (aashirvaad); 1 packet pasta; 1 packet biscuits |

### iv-hi-bigbasket-24423d76 (13)

Gold transcript: मेरे उत्पाद के ऑर्डर चौबीस मंत्रा कॉर्न को एक दशमलव पाँच लीटर लीफ़ी टेल्स गार्डन वाटरिंग केन से बदलें
Gold: **1.5 l corn (24-mantra)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 2 | मेरे उत्पाद के ऑर्डर 24 मंत्रा कॉन को 1.5 लीटर लिफीटेस गार्डन वॉटरिंग कैन से बदलें। | ∅ |
| openai/harness | 2 | मेरे उत्पाद के ऑर्डर चौबीस मंत्रा कॉर्न को एक दशमलव पाँच लीटर लिफीटेस गार्डन वॉटरिंग कैन से बदलें। | ∅ |
| sarvam/plain | 2 | मेरे उत्पाद के ऑर्डर 24 मंत्रा कॉर्न को 1.5 लीटर लीफी टेल्स गार्डन वाटरिंग कैन से बदलें। | ∅ |
| sarvam/harness | 3 | मेरे उत्पाद के ऑर्डर 24 मंत्रा कॉर्न को 1.5 लीटर लीफी टेल्स गार्डन वाटरिंग कैन से बदलें। | 24 piece corn |
| whisper-cpp/plain | 2 | मेरे उत्वात के ओर्डर 24 मंत्रा कौन को 1.5 लिटर लिफी टेल्स गार्डन वाटरिंग कैन से बदले। | ∅ |
| whisper-cpp/harness | 2 | मेरे उत्वात के order 24 मंत्रा कौन को 1.5 लिटर leafy tails garden watering can से बदले | ∅ |

### iv-te-bigbasket-f7bdd369 (12)

Gold transcript: నా గత ఆర్డర్ మళ్ళీ చేస్తూ అందులో రెండు ప్యాకెట్‌లు ప్యూరామేట్ లిక్విడ్ ఫుడ్ కలర్‌ని చేర్చి అమెరికన్ గార్డెన్ మైక్రోవేవ్ పాప్ కార్న్‌ని తీసేయ్
Gold: **5 kg atta (aashirvaad)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 2 | నా గత ఆర్డర్ మళ్లీ చేస్తూ అందులో రెండు ప్యాకెట్లు ప్యూరామేట్ లిక్విడ్ ఫుడ్ కలర్ని చేర్చి అమెరికన్ గార్డెన్ మైక్రోవేవ్ పాప్కార్న్ని తీసేయి. | ∅ |
| openai/harness | 2 | నా గత ఆర్డర్ మళ్లీ చేస్తూ అందులో రెండు ప్యాకెట్లు ప్యూరామేట్ లిక్విడ్ ఫుడ్ కలర్్ని చేర్చి అమెరికన్ గార్డెన్ మైక్రోవేవ్ పాప్కార్న్్ని తీసేయి. | ∅ |
| sarvam/plain | 2 | నా గత ఆర్డర్ మళ్ళీ చేస్తూ, అందులో 2 ప్యాకెట్లు ప్యూరామేట్ లిక్విడ్ ఫుడ్ కలర్ని చేర్చి, అమెరికన్ గార్డెన్ మైక్రోవేవ్ పాప్కార్న్ని తీసేయి. | ∅ |
| sarvam/harness | 2 | నా గత ఆర్డర్ మళ్ళీ చేస్తూ, అందులో 2 ప్యాకెట్లు ప్యూరామేట్ లిక్విడ్ ఫుడ్ కలర్ని చేర్చి, అమెరికన్ గార్డెన్ మైక్రోవేవ్ పాప్కార్న్ తీసేయి. | ∅ |
| whisper-cpp/plain | 2 | నా గతా ఆడార్ మల్లి చేస్తు అందిలో రోండు పేకిట్లు భ్యోరా మేట్ లిక్వీడ్ ఫుడ్ కలర్ని చేర్చి అమిరికం గార్డిన్ మైక్రోవేవ్ పా� | ∅ |
| whisper-cpp/harness | 2 | nā gatha harder, malli, cheshtu, anddhi, lao, ronde, packet, lu, pyora, made liquid food color nyi, chera, american garden, microwave, popcorn nyi, thiisaayi | ∅ |

### iv-hi-bigbasket-66868606 (10)

Gold transcript: ग्रामी सुपरफूड चिया सीड्स को छोड़कर मेरा पिछला आर्डर दोहराएँ
Gold: **5 kg atta (aashirvaad)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 2 | ग्रामी सुपरफूड चिया सीड्स को छोड़कर मेरा पिछला ऑर्डर दोहराएं। | ∅ |
| openai/harness | 2 | ग्रामी सुपरफूड चिया सीड्स को छोड़कर मेरा पिछला ऑर्डर दोहराएं। | ∅ |
| sarvam/plain | 2 | ग्रामी सुपर फ़ूड चिया सीड्स को छोड़कर मेरा पिछला ऑर्डर दोहराएँ। | ∅ |
| sarvam/harness | 0 | ग्रामी सुपर फ़ूड चिया सीड्स को छोड़कर मेरा पिछला ऑर्डर दोहराएँ। | 5 kg atta (aashirvaad) |
| whisper-cpp/plain | 2 | ग्रामी, सूपर फूड, चीया, सीट्स को छोड़ कर मेरा पिछला ओर्डर दो रहें | ∅ |
| whisper-cpp/harness | 2 | grammy, superfood, chia seeds, ko, choďkar, mera, pichla order, dohrahen | ∅ |

### iv-te-bigbasket-06f702d8 (10)

Gold transcript: రేపటికి డెలివరీ అవ్వవల్సిన ఆర్డర్ మళ్ళీ చేసి అందులో బోర్జస్ వేగన్ న్యాచురా రైస్ అండ్ ఆల్మాండ్‍కి బదులు ఐదు వందలు గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి
Gold: **500 g curry-leaves (fresho)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 3 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ బల్లి చేసి, అందులో బోర్చస్ వే�గర్ నేచురల్ రైస్ అండ్ ఆల్మండ్ కిబ్బుల్ ఐదు వందల గ్రాముల ఫ్రెషో కర్వేపాకు యాడ్ చేయి. | 1 kg rice; 1 bunch curry-leaves (fresho) |
| openai/harness | 2 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ బల్లి చేసి, అందులో బవర్చస్ వేగర్ నేచురల్ రైస్ ఆడాల్బట్ కి బదులు ఐదు వందల గ్రాముల ఫ్రెషో కర్వే పాకు యాడ్ చేయి. | ∅ |
| sarvam/plain | 0 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ మళ్ళీ చేసి, అందులో బోర్జస్ వీగన్ న్యాచురల్ రైస్ అండ్ ఆల్మండ్ కి బదులు 500 గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి. | 500 g curry-leaves (fresho) |
| sarvam/harness | 0 | రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ మళ్ళీ చేసి, అందులో బోర్జస్ వీగన్ న్యాచురల్ రైస్ అండ్ ఆల్మండ్ కి బదులు 500 గ్రాముల ఫ్రెషో కరివేపాకు యాడ్ చేయి. | 500 g curry-leaves (fresho) |
| whisper-cpp/plain | 2 | రిపటికె టిలవరి ఆభవలసుర ఆడర బల్లి చేసి అద్దలో బోర్చస్ వేగన్ నాచ్రా రైస్ అడాల్పాట్ కిపతులు ఆిదు ఒదల గ్రాబుల ఫ్రశో కరువె ప | ∅ |
| whisper-cpp/harness | 3 | ripatikki delivery, avavalsi, order, balli, chaise, adlal, boarches, vegan natural rice, adalbat, keepathil, aithodal gram, fresh, karve, pakku, add, chaise | 1 kg rice |

### iv-te-bigbasket-3cdd5b59 (10)

Gold transcript: నా కార్టులో విన్‍గ్రీన్ ఫామ్ కెమొమాయిల్ పూలు గల గ్రీన్ టీ తీసివేసి దానికి బదులు వెయ్యి గ్రాముల స్లర్ప్ ఫర్మ్ ఇంస్టంట్ ఓట్స్ పౌడర్ వేయి
Gold: **1000 g oats (slurp-firm)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | నా కార్డ్లో విన్గ్రీన్ ఫామ్ కిమోమైల్ పూల్గల గ్రీన్ టీ, టీసీ వేసి దాని బదులు వెయ్యి గ్రాముల స్లర్ఫమ్ ఇన్స్టాంట్ ఓట్స్ పౌడర్ వేయి. | 1000 g oats (slurfm) |
| openai/harness | 1 | నా కార్డ్లో విన్గ్రీన్ ఫామ్ కెమోమైల్ పూలగల గ్రీన్ టీ, టీసీ వేసి దాని బదులు వెయ్యి గ్రాముల స్లర్ఫమ్ ఇన్స్టంట్ ఓట్స్ పౌడర్ వేయి. | 1000 g oats (slurfam) |
| sarvam/plain | 1 | నా కార్టులో విన్ గ్రీన్ ఫామ్ కెమోమైల్ పూలు గల గ్రీన్ టీ తీసివేసి, దాని బదులు 1000 గ్రాముల స్లర్ప్ ఫామ్ ఇన్స్టంట్ ఓట్స్ పౌడర్ వేయి. | 1000 g oats (slurrp-farm) |
| sarvam/harness | 1 | నా కార్టులో విన్ గ్రీన్ ఫామ్ కెమోమైల్ పూలు గల గ్రీన్ టీ తీసివేసి, దాని బదులు 1000 గ్రాముల స్లర్ప్ ఫామ్ ఇన్స్టంట్ ఓట్స్ పౌడర్ వేయి. | 1000 g oats (slurrp-farm) |
| whisper-cpp/plain | 2 | నా కాడ్లో విన్ గ్రిం ఫామ్ కిమో మయిల్ పూల్ గ్రింటి తీసి వేసి దాని బదలు వైయి గ్రామ్ల స్లర్ఫామ్ ఇంస్టాంస్ పోడర్ వైయి | ∅ |
| whisper-cpp/harness | 4 | na kardlo, wind green farm, keemomail, poolgala green tea, tc vese, dhani badalu, vei yi gramla, slurp farm, instant oats powder vei | 0 packet tea; 0 packet oats |

### iv-hi-bigbasket-1a282af2 (8)

Gold transcript: मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें
Gold: **5 packet kabuli-chana (naturaland-organics)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 0 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | 5 packet kabuli-chana (naturaland-organics) |
| openai/harness | 0 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को पाँच पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | 5 packet kabuli-chana (naturaland-organics) |
| sarvam/plain | 2 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को 5 पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | ∅ |
| sarvam/harness | 0 | मेरे उत्पाद के ऑर्डर नेचरलैंड ऑर्गेनिक्स होल चना को 5 पैकेट आर्य ऑर्गेनिक त्रिफला पाउडर से बदलें। | 5 packet kabuli-chana (naturaland-organics) |
| whisper-cpp/plain | 3 | मेरे उत्पाद के ओर्डर नेचर लेंड ओर्गैनिक्स होल चना को पांच पैकेट आर्रे ओर्गैनिक त्रीफला पाउडर से बदलें | 5 packet kala-chana (natureland-organics) |
| whisper-cpp/harness | 3 | मेरे उत्पाद के order, nature land, organics, whole chana ko, 5 packet, rray, organic, trifola powder से बदले | 5 packet kala-chana |

### iv-te-bigbasket-5430e654 (6)

Gold transcript:  సున్నాపాయింట్ ఐదు కిలో బీబీ రాయల్ కిస్‍మిస్ పళ్ళు ధర ఎంత
Gold: **∅**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | సున్నా పాయింట్ ఐదు కిలో బీబీ రాయల్ కిస్మిస్ పల్లు ధర ఎంత. | 0.5 kg raisins (bb-royal) |
| openai/harness | 1 | సున్నా పాయింట్ ఐదు కిలో బీబీ రాయల్ కిస్మిస్ పల్లు ధర ఎంత. | 0.5 kg raisins (bb-royal) |
| sarvam/plain | 1 | 0.5 కిలో బీబీ రాయల్ కిస్మిస్ పళ్ళు ధర ఎంత? | 0.5 kg raisins (bb-royal) |
| sarvam/harness | 1 | 0.5 కిలో బీబీ రాయల్ కిస్మిస్ పళ్ళు ధర ఎంత? | 0.5 kg raisins (bb-royal) |
| whisper-cpp/plain | 1 | 7 కిలో బిబి రోయల్ కిస్మిస్ పల్లు దరయంతా | 7 kg raisins (bb-royal) |
| whisper-cpp/harness | 1 | Suna point 5 kilo BB royal kismis pallu darayanta | 5 kg raisins (bb-royal) |

### iv-hi-bigbasket-08eeb3eb (4)

Gold transcript: मैं पाँच कार्टन चिज़ज़पा पोटैटो क्रिस्प चिप्स के अलावा शून्य दशमलव पाँच लीटर बास्किन रोब्बिंस चॉकलेट आइसक्रीम अपनी वस्तुओं की सूची में जोड़ना चाहता हूँ
Gold: **∅**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | मैं पाँच कार्टन चीज़ जपा पोटैटो क्रिप्स चिप्स के अलावा शून्य दशमलव पाँच लीटर बास्किन रॉबिन्स चॉकलेट आइसक्रीम अपनी वस्तुओं की सूची में जोड़ना चाहता हूँ। | 5 packet cheese |
| openai/harness | 1 | मैं पाँच कार्टन चीज़ जपा पोटैटो क्रिप्स चिप्स के अलावा शून्य दशमलव पाँच लीटर बास्किन रॉबिन्स चॉकलेट आइसक्रीम अपनी वस्तुओं की सूची में जोड़ना चाहता हूँ। | 5 packet cheese |
| sarvam/plain | 0 | मैं 5 कार्टन चिज़ज़पा पोटैटो क्रिस्प्स चिप्स के अलावा 0.5 लीटर बास्किन रोब्बिन्स चॉकलेट आइसक्रीम अपनी वस्तुओं की सूची में जोड़ना चाहता हूँ। | ∅ |
| sarvam/harness | 0 | मैं 5 कार्टन चिज़ज़पा पोटैटो क्रिस्प्स चिप्स के अलावा 0.5 लीटर बास्किन रोब्बिंस चॉकलेट आइसक्रीम अपनी वस्तुओं की सूची में जोड़ना चाहता हूँ। | ∅ |
| whisper-cpp/plain | 0 | मैं पाच कार्टन चिज जपा पोटेटो क्रिप्स चिप्स की अलावा सूने दसमलब पाच लीटर बासकिन रोबिन्स चॉकलेट आइसक्रीम अपनी वस्तूओं की सूची में जोडना चाहता हूं। | ∅ |
| whisper-cpp/harness | 2 | मैं 5 carton, chiz, japa, potato, krips, chips, की अलावा, सुने दसमलब 5 liter, baskin, robbins, chocolate ice cream, अपनी वस्तुों की सूची में जोडना चाहता हूँ | 1 packet cheese; 1 kg potato |

### iv-hi-bigbasket-c5ad6286 (4)

Gold transcript: मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हेंको डिटर्जेंट बार जोड़ें
Gold: **0.25 kg detergent-powder (henko)**

| run | bad | STT hyp | pred |
|---|---|---|---|
| openai/plain | 1 | मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हैंगो डिटर्जेंट बार जोड़ें। | 0.25 kg detergent-powder |
| openai/harness | 1 | मेरी आइटम सूची में शून्य दशमलव दो पाँच किलो हैंगो डिटर्जेंट बार जोड़ें। | 0.25 kg detergent-powder |
| sarvam/plain | 0 | मेरी आइटम सूची में 0.25 किलो हैंको डिटर्जेंट बार जोड़ें। | 0.25 kg detergent-powder (henko) |
| sarvam/harness | 1 | मेरी आइटम सूची में 0.25 किलो हैंको डिटर्जेंट बार जोड़ें। | 0.25 kg detergent-powder |
| whisper-cpp/plain | 0 | मेरी आइटम सूची में 0.25 किलो हैंको डिटरजिन बार जोडें। | 0.25 kg detergent-powder (henko) |
| whisper-cpp/harness | 1 | میری item सूची में 0.25 kg hanko detergent bar जोडे | 0.25 kg detergent-powder (hanko) |
