// Quick test script for experimental login+scrape
// Usage: node experimental/test_login.js <rollNumber> <password>
const args = process.argv.slice(2);
const rollNumber = args[0] || '2024UME4113';
const password = args[1] || 'changeme';

if (args.length < 2) {
    console.log('Usage: node experimental/test_login.js <rollNumber> <password>');
    console.log(`Using: rollNumber=${rollNumber}, password=${password}`);
}

const startTime = Date.now();

try {
    const res = await fetch('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            rollNumber,
            password,
            year: '2025-26',
            semester: '4'
        })
    });

    const data = await res.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n--- TEST RESULT (${elapsed}s) ---`);
    console.log(`Status: ${res.status}`);
    console.log(`Success: ${data.success}`);
    console.log(`Mode: ${data.mode || 'legacy'}`);
    console.log(`Roll: ${data.rollNumber}`);

    if (data.data) {
        console.log(`\nAttendance subjects: ${data.data.attendance?.length || 0}`);
        if (data.data.attendance?.length > 0) {
            console.log('\nSubjects:');
            data.data.attendance.forEach(s => {
                console.log(`  - ${s.subject}: ${s.attendance || s.percentage || 'N/A'}`);
            });
        }
        console.log(`\nProfile: ${JSON.stringify(data.data.home?.profile)}`);
    } else {
        console.log('\n⚠️ NO DATA returned!');
        console.log(JSON.stringify(data, null, 2).substring(0, 500));
    }

    if (data.history) {
        console.log(`\nHistory: CGPA=${data.history.cgpa || 'N/A'}`);
    }
} catch (e) {
    console.error('Test failed:', e.message);
}
