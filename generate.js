// generate.js - imports payroll-20xx.csv and outputs commands.csv and pay.csv

// notes:
// - some officers have payroll data from before they started, likely a bad match, so removed
// - ~6 SRG officers dont have payroll data for when they started SRG because they changed name
// - ~30 officers joined SRG after fiscal year end on 6/30
// - consider removing pay data for the first year an officer joined, as they likey only worked a partial year
// - consider removing 'not-active' pay data
// - if we're looking at pay increases year to year in SRG vs non-SRG do we need to account for things like days_on_force, rank, awards, etc?

import fs from 'fs'
import path from 'path'
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const SRG_COMMANDS = [
  'STRATEGIC RESPONSE GROUP',
  'STRATEGIC RESP GRP 1 MANHATTAN',
  'STRATEGIC RESP GRP 2 BRONX',
  'STRATEGIC RESP GRP 3 BROOKLYN',
  'STRATEGIC RESP GRP 4 QUEENS',
  'STRATEGIC RESP GRP 5 SI'
]

const payFields = [
  'base_salary', 'regular_hours', 'regular_paid',
  'ot_hours', 'ot_paid',
  'other_paid',
  'total_paid'
]
const recordFields = [...payFields, 'years_on_force']

const asOfDate = new Date('11/30/2021') // date NYPD profiles pulled

function loadData() {
  const files = [
    'payroll_2014.csv',
    'payroll_2015.csv',
    'payroll_2016.csv',
    'payroll_2017.csv',
    'payroll_2018.csv',
    'payroll_2019.csv',
    'payroll_2020.csv',
    'payroll_2021.csv'
  ]

  function isSRGYear(record) {
    if (!SRG_COMMANDS.includes(record.command)) return false

    const assignmentDate = new Date(record.assignment_date)
    const endFY = new Date(`6/30/${record['Fiscal Year']}`)

    return assignmentDate <= endFY
  }

  function isSRGYearJoined(record) {
    if (!SRG_COMMANDS.includes(record.command)) return false

    const assignmentDate = new Date(record.assignment_date)
    const startFY = new Date(`6/30/${record['Fiscal Year'] - 1}`)
    const endFY = new Date(`6/30/${record['Fiscal Year']}`)

    return (assignmentDate > startFY) && (assignmentDate < endFY)
  }

  let records = []
  files.forEach(file => {
    const buffer = fs.readFileSync(path.join(process.cwd(), file)).toString()
    records = records.concat(parse(buffer, {
      columns: true,
      trim: true
    }))
  })

  console.info('imported payroll records:', records.length)

  records = records.map(record => {
    return {
      taxid: record.taxid,
      command: record.command,
      rank: record.rank,
      appt_date: record.appt_date,
      assignment_date: record.assignment_date,
      year: parseInt(record['Fiscal Year'], 10), // July 1 of prev year thru Jun 30

      leave_status: record['Leave Status as of June 30'], // ACTIVE, ON LEAVE, CEASED, ON SEPARATION LEAVE

      base_salary: parseInt(record['Base Salary'], 10),
      regular_hours: parseInt(record['Regular Hours'], 10),
      regular_paid: parseInt(record['Regular Gross Paid'], 10),
      ot_hours: parseInt(record['OT Hours'], 10),
      ot_paid: parseInt(record['Total OT Paid'], 10),
      other_paid: parseInt(record['Total Other Pay'], 10),
      total_paid: parseInt(record['Regular Gross Paid'], 10) + parseInt(record['Total OT Paid'], 10) + parseInt(record['Total Other Pay'], 10),

      is_srg: SRG_COMMANDS.includes(record.command),
      is_srg_year: isSRGYear(record), // was assigned to SRG this FY
      is_srg_year_joined: isSRGYearJoined(record), // was assigned to SRG this FY

      years_on_force: Math.abs(asOfDate - new Date(record.appt_date)) / (1000 * 60 * 60 * 24 * 365)
    }
  })

  // list records not included due to no match
  records = records.filter(record => record.year)
  console.info('profiles matched to payroll:', records.length)

  // remove records where appt_date is after 30 June of that FY
  records = records.filter(record => new Date(record.appt_date) <= new Date(`6/30/${record.year}`))

  return records
}

function getStats(officers) {
  let stats = {
    officer_count: officers.length,
    total: {},
    average: {}
  }

  recordFields.forEach(field => {
    stats.total[field] = officers.reduce((c, o) => c + o[field], 0)
  })

  Object.keys(stats.total).forEach(field => {
    stats.average[field] = stats.total[field] / officers.length
  })

  return stats
}

function saveCommands({ commands, srg, notsrg }) {
  function toRecord(command, obj) {
    let record = {}
    record.command = command
    record.officers = obj.officer_count
    recordFields.forEach(field => {
      record[`avg_${field}`] = obj.average[field]
    })
    recordFields.forEach(field => {
      record[`total_${field}`] = obj.total[field]
    })
    return record
  }

  let records = []
  records.push(toRecord('ALL SRG', srg))
  records.push(toRecord('NON-SRG', notsrg))
  for (const [key, value] of byCommand.entries()) {
    records.push(toRecord(key, value.stats))
  }

  fs.writeFileSync('commands.csv', stringify(records, { header: true }))
}

function savePayChange(records) {
  fs.writeFileSync('pay.csv', stringify(records, { header: true }))
}

//

let records = loadData()

// gather command data for 2021
let byCommand = new Map()
records.forEach(record => {
  if (record.year !== 2021) return

  let command = byCommand.get(record.command)
  if (command) {
    command.officers.push(record)
    byCommand.set(record.command, command)
  } else {
    byCommand.set(record.command, { command: record.command, officers: [record] })
  }
})

for (const [key, value] of byCommand.entries()) {
  value.stats = getStats(value.officers)
  byCommand.set(key, value)
}
byCommand = new Map([...byCommand].sort((a, b) => String(a[0]).localeCompare(b[0])))

saveCommands({
  commands: byCommand,
  srg: getStats(records.filter(record => record.is_srg && record.year === 2021)),
  notsrg: getStats(records.filter(record => !record.is_srg && record.year === 2021))
})


// gather paid increase

// all payroll records for each officer
let byTaxid = new Map()
records.forEach(record => {
  let officer = byTaxid.get(record.taxid)
  if (officer) {
    officer.payroll.push(record)
    byTaxid.set(record.taxid, officer)
  } else {
    byTaxid.set(record.taxid, {
      taxid: record.taxid,
      payroll: [record]
    })
  }
})

// calculate change in pay from previous year, save it in byTaxid
//
// NOTE: ~36 officers assigned to SRG dont have a payroll entry for
// the year they joined, even though we have payroll data from 2014
// and SRG was formed in 2015.  This is likely due to:
// - officer assigned to SRG after 6/30/21
// - officer changed names (often female likley married, ~6) and
//   payroll entry wasnt matched for earlier years

byTaxid.forEach(officer => {
  officer.payroll = officer.payroll.map(entry => {
    const year = entry.year
    const prev = officer.payroll.find(entry => entry.year == (year - 1))
    if (prev) {
      payFields.forEach(field => {
        entry[`${field}_change`] = entry[field] - prev[field]
      })
    }
    return entry
  })
  byTaxid.set(officer.taxid, officer)
})

let srgJoinYears = []
let otherYears = []
byTaxid.forEach(officer => {
  officer.payroll.forEach(entry => {
    if (entry.total_paid_change === undefined) return
    if (entry.is_srg_year_joined) {
      srgJoinYears.push(entry)
    } else {
      otherYears.push(entry)
    }
  })
})

// 2015-2021
savePayChange(payFields.map(field => {
  const payChangeField = `${field}_change`

  return {
    field: payChangeField,
    'change first srg year': srgJoinYears.reduce((c, o) => c + o[payChangeField], 0) / srgJoinYears.length,
    'change other years': otherYears.reduce((c, o) => c + o[payChangeField], 0) / otherYears.length
  }
  // this could be shown as % using average values,
  // assuming SRG has higher average salary by virtue of tenure or rank
}))
