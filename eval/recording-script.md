# Recording script: cook voice notes

30 WhatsApp-style voice notes for the headline eval. Gold labels are in `eval/gold/recorded/<id>.json` (same shape as `fixtures/cases`).

## How to record
- **Read each line verbatim**, including fillers ("umm", "haan haan") and self-corrections. The text is the WER reference and the gold depends on it. If you slip, re-record. Don't edit the gold.
- Talk at a cook's pace with normal kitchen or room noise. No studio voice. Record on your phone in WhatsApp (hold to record), then export.
- Save the file as `eval/data/recorded/<id>.<ext>` (for example `rec-07.opus`). Any of .opus, .ogg, .m4a, .wav or .mp3 works. `eval/data/` is gitignored, so **never commit the audio**.
- Rows marked `te` are romanized Telugu. Read them like a Telugu speaker would.

## Conventions the gold assumes (Lanes 1 and 3, please match)
- "wahi wala" means the household's preferred brand from `fixtures/household.json`: atta → `aashirvaad`, milk → `amul`, rice → `india-gate`.
- Brand ids used: `aashirvaad`, `amul`, `britannia`, `fortune`, `india-gate`, `surf-excel`, `tata`, `vim`.
- Bare counts ("das nimbu", "ek lauki") use the `piece` unit. "Bar" is `piece`, "gaddi"/"katta" is `bunch`, "darjan" is `dozen`.
- The scorer treats 250 g and 0.25 kg as equal, and 500 ml and 0.5 l as equal.
- Self-corrections keep the final value. Negated items ("pyaaz mat lana") produce no line.
- An advance is `{ amount, reason }` and only `amount` is scored. Notes are not scored.

| id | lang | tests | say this |
|---|---|---|---|
| rec-01 | hi | wahi wala, packet | Didi, atta khatam ho gaya hai. Wahi wala paanch kilo mangwa dena. Aur ek packet Amul butter bhi. |
| rec-02 | hi | dedh, paav | Bhaiya, dedh kilo pyaaz, ek kilo tamatar aur paav kilo adrak le aana. |
| rec-03 | hi | gaddi, dhai sau, filler | Madam ji, do gaddi dhaniya, ek gaddi pudina aur dhai sau gram hari mirch. Kal main thoda late aaungi, bacche ke school mein meeting hai. |
| rec-04 | hi | ADVANCE, wahi wala | Didi, ek baat bolni thi. Mujhe is mahine do hazaar advance chahiye, gaon mein maa ki tabiyat kharab hai. Aur haan, doodh wahi wala do packet le lena. |
| rec-05 | hi | self-correction, darjan | Aloo teen kilo... nahi nahi, do kilo kaafi hai. Aur ek darjan ande, aur ek packet bread. |
| rec-06 | hi | wahi wala | Didi, chawal wahi wala das kilo ka bag le lo. Toor dal do kilo, aur moong dal ek kilo. |
| rec-07 | hi | negation, filler, aadha | Haan didi, sun rahe ho? Woh sabzi wala aaj nahi aaya. Toh bhindi aadha kilo, baingan aadha kilo, aur ek lauki mangwa do. Pyaaz mat lana, abhi ghar mein hai. |
| rec-08 | hi | ADVANCE, saade, litre | Didi, saade teen sau rupaye advance chahiye the, bijli ka bill bharna hai. Aur do litre doodh, ek kilo dahi. |
| rec-09 | hi | brand, diet rule | Ek packet Tata namak, ek kilo cheeni, aur paanch sau gram chai patti. Papa ke liye cheeni kam use karni hai, yaad hai na. |
| rec-10 | hi | brand, litre | Didi, Fortune ka sarson ka tel ek litre, aur ek kilo besan. Kal pakode banaungi. |
| rec-11 | hi | dhai, saade, count | Dhai kilo aloo, saade teen kilo pyaaz aur das nimbu. |
| rec-12 | hi | household, brand | Didi, do Vim bar, ek packet Surf Excel, aur do packet kachre ki thaili. |
| rec-13 | hi | ADVANCE only, dedh hazaar | Didi, mujhe dedh hazaar advance chahiye, bete ki fees bharni hai. Agle mahine ki salary se kaat lena. |
| rec-14 | hi | grams, brand | Paneer do sau gram, aur ek packet Amul cheese. Aur matar aadha kilo. Aaj raat ko matar paneer banega. |
| rec-15 | hi | masala, packet | Didi, haldi ka ek packet, laal mirch powder ek packet, aur jeera sau gram. Masale sab khatam ho rahe hain. |
| rec-16 | hi | filler heavy, darjan | Haan haan, achha suno... woh kya hai na, kal mehmaan aa rahe hain, toh... ek kilo chicken, aur, umm, do darjan ande. Aur haan, ek packet dahi bhi. |
| rec-17 | hi | ADVANCE, packet | Didi, teen hazaar advance mil sakta hai kya? Ghar ka kiraya dena hai. Aur bacchon ke liye chaar packet Maggi le aana. |
| rec-18 | hi | aadha, brand | Sooji aadha kilo, poha ek kilo, aur do packet Britannia biscuit. |
| rec-19 | hi | self-correction, paav | Didi, do gobhi... nahi nahi, ek hi kaafi hai. Gaajar ek kilo, aur shimla mirch paav kilo. |
| rec-20 | hi | brand, count | Ek litre Amul ghee aur ek packet Amul butter. Aur chhe kele. |
| rec-21 | hi | ADVANCE only, note | Didi, paanch sau rupaye advance chahiye, dawai leni hai. Aur kal subah aath baje aaungi. |
| rec-22 | hi | gaddi, grams | Kadi patta ek gaddi, sarson ke daane sau gram, aur imli do sau gram. Kal sambar banana hai. |
| rec-23 | hi | brand override, wahi wala | Didi, Mother Dairy ka doodh nahi, wahi wala lena, teen packet. Aur ek packet dahi. |
| rec-24 | hi | ADVANCE + groceries, wahi wala | Ek kilo masoor dal, aadha kilo rajma, aur do kilo wahi wala atta. Aur didi, mujhe aath sau rupaye advance chahiye, gas cylinder ke liye. |
| rec-25 | hi | self-correction, count | Saade paanch sau gram bhindi... matlab aadha kilo bhindi kar do. Aur ek kheera, do shakarkandi. |
| rec-26 | hi | ADVANCE big, darjan | Didi, mujhe pachchees sau advance chahiye, beti ki shaadi ki taiyari hai. Haan, aur ek darjan kele bhi le aana. |
| rec-27 | te | Telugu | Amma, rendu kilo tomatolu, oka kilo ullipayalu, inka rendu kattalu kottimeera teesukurandi. |
| rec-28 | te | Telugu, ara, pavu | Akka, kandi pappu oka kilo, minapappu ara kilo, inka pavu kilo pachi mirchi kavali. |
| rec-29 | te | Telugu, ADVANCE | Amma, naaku veyyi rupayalu advance kavali, intlo current bill kattali. Inka rendu packet palu teesukurandi. |
| rec-30 | hi | Hyderabadi Hindi-Telugu mix | Didi, karivepaku oka katta, perugu ara kilo, aur do kilo aloo bhi le aana. |
