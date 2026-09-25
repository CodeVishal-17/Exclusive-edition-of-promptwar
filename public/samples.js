// Sample document for quick evaluation. Deliberately contains a mix of fair
// and one-sided clauses so the analysis has something meaningful to flag.
export const SAMPLE_RENTAL_AGREEMENT = `RESIDENTIAL LEASE AND LICENCE AGREEMENT

This Agreement is made on 1st October 2026 at Pune between Mr. Rajesh Kulkarni ("Licensor") and Ms. Ananya Sharma ("Licensee").

1. PREMISES. The Licensor grants the Licensee a licence to occupy Flat No. 304, Green Meadows, Baner, Pune ("Premises") for residential use only.

2. TERM. The licence is for 11 months commencing 1st October 2026. Renewal shall be at the sole discretion of the Licensor.

3. LICENCE FEE. The Licensee shall pay Rs. 28,000 per month on or before the 3rd day of each month. A late fee of Rs. 1,000 per day shall be charged for every day of delay.

4. SECURITY DEPOSIT. The Licensee shall pay an interest-free security deposit of Rs. 1,50,000. The deposit shall be refunded within 90 days of vacating, after deducting any amounts the Licensor in his sole opinion considers due for damages, repainting, cleaning or unpaid dues. The Licensor's decision on deductions shall be final.

5. ESCALATION. The Licensor may increase the licence fee at any time during the term by giving 7 days' notice.

6. LOCK-IN AND TERMINATION. There is a lock-in period of 11 months. If the Licensee vacates before the end of the lock-in, the Licensee shall pay the licence fee for the entire remaining lock-in period and forfeit the security deposit. The Licensor may terminate this Agreement at any time by giving 15 days' notice.

7. MAINTENANCE. All repairs, including structural repairs and replacement of fixtures, plumbing and electrical wiring, shall be carried out by the Licensee at the Licensee's own cost.

8. ACCESS. The Licensor or his agents may enter the Premises at any time without prior notice for inspection.

9. GUESTS. The Licensee shall not permit any guest to stay overnight for more than 2 nights in a month without written permission of the Licensor.

10. UTILITIES. Electricity, water and society maintenance charges shall be borne by the Licensee as per actual bills.

11. INDEMNITY. The Licensee shall indemnify the Licensor against all losses, claims and damages of any nature whatsoever arising in connection with the Premises, whether or not caused by the Licensee.

12. DISPUTES. Any dispute shall be subject to the exclusive jurisdiction of the courts at Pune.

Signed:
Licensor: Rajesh Kulkarni
Licensee: Ananya Sharma
Witnesses: 1. ____________ 2. ____________`;

// A revised draft of the same agreement, for trying the Compare workflow.
export const SAMPLE_RENTAL_AGREEMENT_REVISED = SAMPLE_RENTAL_AGREEMENT
  .replace('A late fee of Rs. 1,000 per day shall be charged for every day of delay.',
    'A late fee of Rs. 200 per day shall be charged for every day of delay beyond 5 days, capped at Rs. 2,000 per month.')
  .replace('The deposit shall be refunded within 90 days of vacating, after deducting any amounts the Licensor in his sole opinion considers due for damages, repainting, cleaning or unpaid dues. The Licensor\'s decision on deductions shall be final.',
    'The deposit shall be refunded within 30 days of vacating, after deducting only documented unpaid dues and the reasonable cost of repairing damage beyond normal wear and tear, with receipts shared with the Licensee.')
  .replace('The Licensor may increase the licence fee at any time during the term by giving 7 days\' notice.',
    'The licence fee shall remain fixed for the term of this Agreement.')
  .replace('The Licensor may terminate this Agreement at any time by giving 15 days\' notice.',
    'Either party may terminate this Agreement by giving 60 days\' written notice after the lock-in period of 3 months.')
  .replace('There is a lock-in period of 11 months. If the Licensee vacates before the end of the lock-in, the Licensee shall pay the licence fee for the entire remaining lock-in period and forfeit the security deposit.',
    'There is a lock-in period of 3 months. If the Licensee vacates during the lock-in, the Licensee shall pay one month\'s licence fee as compensation.')
  .replace('The Licensor or his agents may enter the Premises at any time without prior notice for inspection.',
    'The Licensor may inspect the Premises at a mutually agreed time after giving at least 24 hours\' notice.');
